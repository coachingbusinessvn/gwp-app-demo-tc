import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_PASSWORD,
  fixture,
  personaEmail,
  type Persona,
} from "../helpers/fixture.js";

/**
 * POST /api/v1/users/:id/reactivate — the inverse of deactivate (spec §4/§8).
 *
 * State machine: only an INACTIVE account can be reactivated (409
 * USER_NOT_INACTIVE otherwise). Deactivation keeps the password hash and
 * durably revokes every session, so reactivation:
 *   - restores a previously activated account to ACTIVE with its existing
 *     password — but never its old sessions (they were revoked for good;
 *     a fresh login is required, and the owner can issue a reset code if
 *     the credential is no longer trusted);
 *   - returns a never-activated account (no password) to PENDING — the
 *     owner then issues a one-time activation code as for a new user.
 * Authorization mirrors deactivate: owner/admin, and admin only for plain
 * (non-owner/admin) accounts.
 *
 * Seed tree (tests/helpers/seed-personas.ts):
 *   member → manager → owner,  outsider → owner
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
type TestResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};

function post(
  f: Fixture,
  persona: Persona | undefined,
  path: string,
  body?: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(path)
    .send(body ?? {}) as unknown as Promise<TestResponse>;
}

const deactivate = (f: Fixture, p: Persona | undefined, id: string) =>
  post(f, p, `/api/v1/users/${id}/deactivate`);
const reactivate = (
  f: Fixture,
  p: Persona | undefined,
  id: string,
  body?: Record<string, unknown>,
) => post(f, p, `/api/v1/users/${id}/reactivate`, body);

async function grantRoles(f: Fixture, userId: string, roles: string[]) {
  const res = (await f
    .api("owner")
    .put(`/api/v1/users/${userId}/roles`)
    .send({ roles })) as unknown as TestResponse;
  expect(res.status).toBe(200);
}

describe("POST /api/v1/users/:id/reactivate", () => {
  it("owner reactivates an inactive member — active again, roles kept, old sessions stay dead, fresh login works, audited", async () => {
    const f = await fixture({ seeded: true });
    try {
      expect((await deactivate(f, "owner", f.ids.member)).status).toBe(200);

      const res = await reactivate(f, "owner", f.ids.member);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: f.ids.member,
        status: "active",
        roles: ["member"],
      });
      const row = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(row.status).toBe("active");
      // Reporting line and org placement survive the round trip.
      expect(row.manager_id).toBe(f.ids.manager);

      // The pre-deactivation access token was revoked durably —
      // reactivation never resurrects it.
      expect(
        (
          (await f
            .api("member")
            .get("/api/v1/auth/me")) as unknown as TestResponse
        ).status,
      ).toBe(401);
      const live = await f
        .db("auth_session")
        .where({ user_id: f.ids.member })
        .whereNull("revoked_at");
      expect(live).toHaveLength(0);

      // The kept password works again through a REAL login.
      const login = (await f
        .api()
        .post("/api/v1/auth/login")
        .send({
          email: personaEmail("member"),
          password: FIXTURE_PASSWORD,
        })) as unknown as TestResponse;
      expect(login.status).toBe(200);

      const audit = await f
        .db("audit_event")
        .where({
          action: "user.reactivate",
          request_id: res.headers["x-request-id"],
        })
        .first();
      expect(audit).toMatchObject({
        actor_id: f.ids.owner,
        target_type: "app_user",
        target_id: f.ids.member,
        outcome: "success",
      });
      expect(audit.safe_metadata).toMatchObject({ status: "active" });

      // Now active again, the owner may issue a reset code (the credential
      // lifecycle is fully restored).
      const reset = await post(
        f,
        "owner",
        `/api/v1/users/${f.ids.member}/credential-token`,
        { purpose: "reset" },
      );
      expect(reset.status).toBe(201);
    } finally {
      await f.close();
    }
  });

  it("a never-activated account returns to PENDING — the owner then issues an activation code", async () => {
    const f = await fixture({ seeded: true });
    try {
      const created = await post(f, "admin", "/api/v1/users", {
        email: `pending-${randomUUID()}@example.test`,
        name: "Chưa kích hoạt",
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;
      expect((await deactivate(f, "admin", id)).status).toBe(200);

      const res = await reactivate(f, "admin", id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, status: "pending" });

      const audit = await f
        .db("audit_event")
        .where({ action: "user.reactivate", target_id: id })
        .first();
      expect(audit.safe_metadata).toMatchObject({ status: "pending" });

      const activate = await post(
        f,
        "owner",
        `/api/v1/users/${id}/credential-token`,
        { purpose: "activate" },
      );
      expect(activate.status).toBe(201);
    } finally {
      await f.close();
    }
  });

  it("mirrors deactivate's authorization — admin only for plain accounts; members/managers 403; anonymous 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Inactive plain member: admin may reactivate.
      expect((await deactivate(f, "owner", f.ids.member)).status).toBe(200);
      // Members/managers/outsiders cannot; anonymous is 401.
      for (const p of ["manager", "outsider"] as Persona[]) {
        expect((await reactivate(f, p, f.ids.member)).status, p).toBe(403);
      }
      expect((await reactivate(f, undefined, f.ids.member)).status).toBe(401);
      expect((await reactivate(f, "admin", f.ids.member)).status).toBe(200);

      // Inactive ADMIN and inactive OWNER: admin gets 403, owner succeeds.
      await grantRoles(f, f.ids.outsider, ["member", "owner"]);
      expect((await deactivate(f, "owner", f.ids.outsider)).status).toBe(200);
      const manager = (await f
        .api("owner")
        .put(`/api/v1/users/${f.ids.member}/manager`)
        .send({ managerId: f.ids.owner })) as unknown as TestResponse;
      expect(manager.status).toBe(200);
      await grantRoles(f, f.ids.manager, ["manager", "admin"]);
      expect((await deactivate(f, "owner", f.ids.manager)).status).toBe(200);

      const deniedOwner = await reactivate(f, "admin", f.ids.outsider);
      expect(deniedOwner.status).toBe(403);
      expect((await reactivate(f, "admin", f.ids.manager)).status).toBe(403);
      const still = await f
        .db("app_user")
        .whereIn("id", [f.ids.outsider, f.ids.manager])
        .select("status");
      expect(still.map((r: { status: string }) => r.status)).toEqual([
        "inactive",
        "inactive",
      ]);

      expect((await reactivate(f, "owner", f.ids.outsider)).status).toBe(200);
      expect((await reactivate(f, "owner", f.ids.manager)).status).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("only an inactive account can be reactivated (409); unknown/malformed 404; unexpected keys 400", async () => {
    const f = await fixture({ seeded: true });
    try {
      const active = await reactivate(f, "owner", f.ids.member);
      expect(active.status).toBe(409);
      expect(active.body.code).toBe("USER_NOT_INACTIVE");

      const created = await post(f, "owner", "/api/v1/users", {
        email: `pending-${randomUUID()}@example.test`,
        name: "Đang chờ",
      });
      const pending = await reactivate(f, "owner", created.body.id as string);
      expect(pending.status).toBe(409);
      expect(pending.body.code).toBe("USER_NOT_INACTIVE");

      expect((await reactivate(f, "owner", randomUUID())).status).toBe(404);
      expect((await reactivate(f, "owner", "not-a-uuid")).status).toBe(404);

      expect((await deactivate(f, "owner", f.ids.member)).status).toBe(200);
      const extra = await reactivate(f, "owner", f.ids.member, {
        status: "active",
      });
      expect(extra.status).toBe(400);
      expect(extra.body.code).toBe("INVALID_INPUT");
      const row = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(row.status).toBe("inactive");
    } finally {
      await f.close();
    }
  });
});
