import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixture, personaEmail, type Persona } from "../helpers/fixture.js";

/**
 * Task 1.3 — user lifecycle surface (spec §3/§4/§8):
 *
 *   PUT   /api/v1/users/:id/roles      — owner only; full-set replace over
 *                                        {owner,admin,manager,member};
 *                                        removing the last ACTIVE owner → 409
 *   POST  /api/v1/users                — owner/admin; creates a PENDING member
 *                                        (no password, role member only)
 *   PATCH /api/v1/users/:id            — self, or owner/admin for
 *                                        non-privileged fields; admin can
 *                                        never touch owner/admin profiles
 *   POST  /api/v1/users/:id/deactivate — owner/admin; admin may only
 *                                        deactivate plain members; a target
 *                                        with direct reports of any status
 *                                        needs the owner to decide their new
 *                                        line in the same transaction; every
 *                                        deactivation
 *                                        durably revokes the user's sessions
 *   GET   /api/v1/users[/:id]          — directory read for any member
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

function putRoles(
  f: Fixture,
  persona: Persona | undefined,
  userId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .put(`/api/v1/users/${userId}/roles`)
    .send(body) as unknown as Promise<TestResponse>;
}

function patchUser(
  f: Fixture,
  persona: Persona | undefined,
  userId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .patch(`/api/v1/users/${userId}`)
    .send(body) as unknown as Promise<TestResponse>;
}

function deactivate(
  f: Fixture,
  persona: Persona | undefined,
  userId: string,
  body?: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(`/api/v1/users/${userId}/deactivate`)
    .send(body ?? {}) as unknown as Promise<TestResponse>;
}

function createUser(
  f: Fixture,
  persona: Persona | undefined,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post("/api/v1/users")
    .send(body) as unknown as Promise<TestResponse>;
}

/** Grant the target an extra role through the real API (owner actor). */
async function grantRoles(
  f: Fixture,
  userId: string,
  roles: string[],
): Promise<void> {
  const res = await putRoles(f, "owner", userId, { roles });
  expect(res.status).toBe(200);
}

describe("PUT /api/v1/users/:id/roles", () => {
  it("is owner-only — admin cannot grant owner (not even to self); members/managers 403; anonymous 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      // The brief's literal case: admin tries to become owner.
      expect(
        (await putRoles(f, "admin", f.ids.admin, { roles: ["owner"] })).status,
      ).toBe(403);
      // Admin cannot touch anyone else's roles either.
      expect(
        (
          await putRoles(f, "admin", f.ids.member, {
            roles: ["member", "manager"],
          })
        ).status,
      ).toBe(403);
      for (const p of ["manager", "member", "outsider"] as Persona[]) {
        const res = await putRoles(f, p, f.ids.member, { roles: ["admin"] });
        expect(res.status, p).toBe(403);
      }
      expect(
        (await putRoles(f, undefined, f.ids.member, { roles: ["admin"] }))
          .status,
      ).toBe(401);

      // Nothing changed.
      const rows = await f
        .db("user_role")
        .join("role", "role.id", "user_role.role_id")
        .where({ "user_role.user_id": f.ids.admin })
        .select("role.key");
      expect(rows.map((r: { key: string }) => r.key)).toEqual(["admin"]);
    } finally {
      await f.close();
    }
  });

  it("owner replaces the full role set — union semantics over the allowlist", async () => {
    const f = await fixture({ seeded: true });
    try {
      const promoted = await putRoles(f, "owner", f.ids.member, {
        roles: ["member", "manager"],
      });
      expect(promoted.status).toBe(200);
      expect(promoted.body).toMatchObject({
        id: f.ids.member,
        roles: ["manager", "member"],
      });

      // Replace is a full set, not an append: manager drops back off.
      const demoted = await putRoles(f, "owner", f.ids.member, {
        roles: ["member"],
      });
      expect(demoted.status).toBe(200);
      expect(demoted.body.roles).toEqual(["member"]);

      const rows = await f
        .db("user_role")
        .join("role", "role.id", "user_role.role_id")
        .where({ "user_role.user_id": f.ids.member })
        .select("role.key");
      expect(rows.map((r: { key: string }) => r.key)).toEqual(["member"]);

      // Audit recorded with the acting owner as actor.
      const audit = await f
        .db("audit_event")
        .where({
          action: "user.set_roles",
          request_id: promoted.headers["x-request-id"],
        })
        .first();
      expect(audit).toMatchObject({
        actor_id: f.ids.owner,
        target_type: "app_user",
        target_id: f.ids.member,
        outcome: "success",
      });
    } finally {
      await f.close();
    }
  });

  it("rejects unknown roles and unexpected keys (400); unknown/foreign/malformed targets 404", async () => {
    const f = await fixture({ seeded: true });
    try {
      expect(
        (
          await putRoles(f, "owner", f.ids.member, {
            roles: ["member", "superuser"],
          })
        ).status,
      ).toBe(400);
      expect(
        (await putRoles(f, "owner", f.ids.member, { roles: "admin" })).status,
      ).toBe(400);
      expect(
        (
          await putRoles(f, "owner", f.ids.member, {
            roles: ["member"],
            managerId: f.ids.owner,
          })
        ).status,
      ).toBe(400);
      expect(
        (await putRoles(f, "owner", randomUUID(), { roles: ["member"] }))
          .status,
      ).toBe(404);
      expect(
        (await putRoles(f, "owner", f.ids.otherCompany, { roles: ["member"] }))
          .status,
      ).toBe(404);
      expect(
        (await putRoles(f, "owner", "not-a-uuid", { roles: ["member"] }))
          .status,
      ).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("refuses to strip the owner role from the last ACTIVE owner — even self (409 LAST_OWNER)", async () => {
    const f = await fixture({ seeded: true });
    try {
      const res = await putRoles(f, "owner", f.ids.owner, {
        roles: ["member"],
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("LAST_OWNER");

      // Owner stays owner.
      const rows = await f
        .db("user_role")
        .join("role", "role.id", "user_role.role_id")
        .where({ "user_role.user_id": f.ids.owner })
        .select("role.key");
      expect(rows.map((r: { key: string }) => r.key)).toEqual(["owner"]);

      // With a second active owner the demote succeeds — the invariant is
      // about the company, not the person.
      await grantRoles(f, f.ids.outsider, ["member", "owner"]);
      const ok = await putRoles(f, "owner", f.ids.owner, {
        roles: ["member"],
      });
      expect(ok.status).toBe(200);
      expect(ok.body.roles).toEqual(["member"]);
    } finally {
      await f.close();
    }
  });

  it("serializes two concurrent last-owner demotions — exactly one succeeds", async () => {
    const f = await fixture({ seeded: true });
    try {
      await grantRoles(f, f.ids.outsider, ["member", "owner"]);
      // Two owners now. Each owner demotes THEMSELF so the loser still
      // holds the owner role at check time (demoting the other via the
      // winner's actor would hit 403 — the winner is no longer owner).
      // Two real connections race; the company lock serializes them and
      // the loser re-counts post-commit.
      const [a, b] = await Promise.all([
        putRoles(f, "owner", f.ids.owner, { roles: ["member"] }),
        putRoles(f, "outsider", f.ids.outsider, { roles: ["member"] }),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe("LAST_OWNER");

      // Exactly one owner remains.
      const owners = await f
        .db("user_role")
        .join("role", "role.id", "user_role.role_id")
        .join("app_user", function () {
          this.on("app_user.id", "=", "user_role.user_id").andOn(
            "app_user.company_id",
            "=",
            "user_role.company_id",
          );
        })
        .where({ "role.key": "owner", "app_user.status": "active" })
        .select("app_user.id");
      expect(owners).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/users (create pending member)", () => {
  it("admin and owner create a pending member — no password, role member only", async () => {
    const f = await fixture({ seeded: true });
    try {
      const byAdmin = await createUser(f, "admin", {
        email: "new@example.test",
        name: "Mới",
        title: "Staff",
      });
      expect(byAdmin.status).toBe(201);
      expect(byAdmin.body).toMatchObject({
        status: "pending",
        roles: ["member"],
        email: "new@example.test",
        name: "Mới",
        title: "Staff",
        managerId: null,
      });
      const newId = byAdmin.body.id as string;

      const row = await f.db("app_user").where({ id: newId }).first();
      expect(row).toMatchObject({
        company_id: f.ids.company,
        status: "pending",
        password_hash: null,
        manager_id: null,
      });
      const roles = await f
        .db("user_role")
        .join("role", "role.id", "user_role.role_id")
        .where({ "user_role.user_id": newId })
        .select("role.key");
      expect(roles.map((r: { key: string }) => r.key)).toEqual(["member"]);

      // Owner can create one too.
      const byOwner = await createUser(f, "owner", {
        email: "second@example.test",
        name: "Hai",
      });
      expect(byOwner.status).toBe(201);
      expect(byOwner.body.status).toBe("pending");

      // A pending account cannot authenticate — activation is task 1.4.
      const login = await f.api().post("/api/v1/auth/login").send({
        email: "new@example.test",
        password: "whatever-password",
      });
      expect(login.status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("rejects members/managers (403), anonymous (401), duplicate normalized email (409) and privilege keys (400)", async () => {
    const f = await fixture({ seeded: true });
    try {
      for (const p of ["member", "manager", "outsider"] as Persona[]) {
        const res = await createUser(f, p, {
          email: `${p}-new@example.test`,
          name: "X",
        });
        expect(res.status, p).toBe(403);
      }
      expect(
        (
          await createUser(f, undefined, {
            email: "anon@example.test",
            name: "X",
          })
        ).status,
      ).toBe(401);

      // email_normalized = lower(btrim(email)) — a case variant collides.
      const dupe = await createUser(f, "admin", {
        email: "MEMBER@Example.TEST",
        name: "Clone",
      });
      expect(dupe.status).toBe(409);

      // No smuggling privilege/lifecycle/identity fields — strict schema.
      for (const extra of [
        { roles: ["owner"] },
        { role: "admin" },
        { password: "x".repeat(12) },
        { managerId: f.ids.owner },
        { status: "active" },
      ]) {
        const res = await createUser(f, "owner", {
          email: `k${randomUUID()}@example.test`,
          name: "X",
          ...extra,
        });
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
    } finally {
      await f.close();
    }
  });

  it("assigns department/team at creation; archived or unknown units are rejected", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Vận hành" });
      const team = await f
        .api("admin")
        .post("/api/v1/teams")
        .send({ departmentId: dep.body.id, name: "Tổ A" });

      // teamId alone derives the department (the composite FK demands it).
      const inTeam = await createUser(f, "admin", {
        email: "teamed@example.test",
        name: "Có tổ",
        teamId: team.body.id,
      });
      expect(inTeam.status).toBe(201);
      expect(inTeam.body).toMatchObject({
        departmentId: dep.body.id,
        teamId: team.body.id,
      });

      // A contradicting departmentId/teamId pair is invalid input.
      const dep2 = await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Khác" });
      expect(
        (
          await createUser(f, "admin", {
            email: "mismatch@example.test",
            name: "X",
            departmentId: dep2.body.id,
            teamId: team.body.id,
          })
        ).status,
      ).toBe(400);

      // Unknown units → 404; archived unit → 409 ORG_UNIT_ARCHIVED.
      expect(
        (
          await createUser(f, "admin", {
            email: "d404@example.test",
            name: "X",
            departmentId: randomUUID(),
          })
        ).status,
      ).toBe(404);
      const depArchived = await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Đã lưu trữ" });
      await f
        .api("admin")
        .post(`/api/v1/departments/${depArchived.body.id}/archive`);
      const archived = await createUser(f, "admin", {
        email: "arch@example.test",
        name: "X",
        departmentId: depArchived.body.id,
      });
      expect(archived.status).toBe(409);
      expect(archived.body.code).toBe("ORG_UNIT_ARCHIVED");
    } finally {
      await f.close();
    }
  });
});

describe("PATCH /api/v1/users/:id", () => {
  it("lets a user edit their own non-privileged profile; never role/manager/email/credentials", async () => {
    const f = await fixture({ seeded: true });
    try {
      const self = await patchUser(f, "member", f.ids.member, {
        name: "Member Renamed",
        title: "Senior",
      });
      expect(self.status).toBe(200);
      expect(self.body).toMatchObject({
        id: f.ids.member,
        name: "Member Renamed",
        title: "Senior",
      });

      // Privilege/identity keys are rejected by the strict schema — 400.
      for (const extra of [
        { role: "owner" },
        { roles: ["owner"] },
        { email: "new-mail@example.test" },
        { managerId: f.ids.owner },
        { password: "x".repeat(12) },
        { status: "inactive" },
      ]) {
        const res = await patchUser(f, "member", f.ids.member, {
          name: "Y",
          ...extra,
        });
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
      expect((await patchUser(f, "member", f.ids.member, {})).status).toBe(400);
    } finally {
      await f.close();
    }
  });

  it("owner/admin edit others' plain fields, but admin can never touch owner/admin profiles", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Admin edits a plain member — allowed.
      expect(
        (
          await patchUser(f, "admin", f.ids.member, {
            title: "By admin",
          })
        ).status,
      ).toBe(200);
      // Admin edits own profile — self, allowed.
      expect(
        (await patchUser(f, "admin", f.ids.admin, { name: "Admin Self" }))
          .status,
      ).toBe(200);
      // Admin edits the owner — a privileged profile → 403.
      expect(
        (await patchUser(f, "admin", f.ids.owner, { name: "Hacked" })).status,
      ).toBe(403);
      // Plain members/managers cannot edit others at all.
      expect(
        (await patchUser(f, "member", f.ids.outsider, { name: "No" })).status,
      ).toBe(403);
      expect(
        (await patchUser(f, "manager", f.ids.member, { name: "No" })).status,
      ).toBe(403);
      // A second privileged target: make member an admin, then admin cannot
      // edit them either.
      await grantRoles(f, f.ids.member, ["member", "admin"]);
      expect(
        (await patchUser(f, "admin", f.ids.member, { name: "Hacked" })).status,
      ).toBe(403);
      // Owner edits anyone.
      expect(
        (await patchUser(f, "owner", f.ids.admin, { title: "By owner" }))
          .status,
      ).toBe(200);
      expect(
        (await patchUser(f, undefined, f.ids.member, { name: "No" })).status,
      ).toBe(401);
      expect(
        (await patchUser(f, "owner", randomUUID(), { name: "Ghost" })).status,
      ).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("self-edit covers name/title only — org placement needs owner/admin even on your own row (§4)", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Phòng" });
      const team = await f
        .api("admin")
        .post("/api/v1/teams")
        .send({ departmentId: dep.body.id, name: "Tổ" });

      // name/title self-edit stays allowed for a plain member.
      const self = await patchUser(f, "member", f.ids.member, {
        name: "Own Name",
        title: "IC",
      });
      expect(self.status).toBe(200);
      expect(self.body).toMatchObject({ name: "Own Name", title: "IC" });

      // Members hold zero org-config rights: a member may not place
      // themself — set or clear, alone or bundled with a name (the whole
      // patch fails closed).
      for (const orgPatch of [
        { departmentId: dep.body.id },
        { teamId: team.body.id },
        { departmentId: null },
        { name: "Bundle", departmentId: dep.body.id },
      ]) {
        const res = await patchUser(f, "member", f.ids.member, orgPatch);
        expect(res.status, JSON.stringify(orgPatch)).toBe(403);
      }

      // Admin editing SELF keeps the self rule too — an admin is a
      // privileged target, so its own org fields stay owner-only.
      expect(
        (
          await patchUser(f, "admin", f.ids.admin, {
            departmentId: dep.body.id,
          })
        ).status,
      ).toBe(403);

      // The existing asymmetry is untouched: admin places a plain member,
      // owner places anyone — itself and an admin target included.
      expect(
        (
          await patchUser(f, "admin", f.ids.member, {
            departmentId: dep.body.id,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await patchUser(f, "owner", f.ids.owner, {
            departmentId: dep.body.id,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await patchUser(f, "owner", f.ids.admin, {
            departmentId: dep.body.id,
          })
        ).status,
      ).toBe(200);

      // Member never moved.
      const row = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(row.department_id).toBe(dep.body.id); // set by admin above
      expect(row.team_id).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("validates org assignment on patch — archived unit 409, unknown 404, team/department mismatch 400", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Phòng" });
      const team = await f
        .api("admin")
        .post("/api/v1/teams")
        .send({ departmentId: dep.body.id, name: "Tổ" });

      const moved = await patchUser(f, "admin", f.ids.member, {
        teamId: team.body.id,
      });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({
        departmentId: dep.body.id,
        teamId: team.body.id,
      });

      const dep2 = await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Phòng 2" });
      expect(
        (
          await patchUser(f, "admin", f.ids.member, {
            departmentId: dep2.body.id,
            teamId: team.body.id,
          })
        ).status,
      ).toBe(400);
      // outsider has no team — an unknown departmentId is a plain 404.
      expect(
        (
          await patchUser(f, "admin", f.ids.outsider, {
            departmentId: randomUUID(),
          })
        ).status,
      ).toBe(404);

      const depArchived = await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Cũ" });
      await f
        .api("admin")
        .post(`/api/v1/departments/${depArchived.body.id}/archive`);
      const res = await patchUser(f, "admin", f.ids.outsider, {
        departmentId: depArchived.body.id,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ORG_UNIT_ARCHIVED");
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/users/:id/deactivate", () => {
  it("admin deactivates a plain member; the account flips inactive and its live session dies", async () => {
    const f = await fixture({ seeded: true });
    try {
      // member can still call the API before deactivation.
      expect(
        ((await f.api("member").get("/api/v1/auth/me")) as unknown as TestResponse)
          .status,
      ).toBe(200);

      const res = await deactivate(f, "admin", f.ids.member);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: f.ids.member, status: "inactive" });

      const row = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(row.status).toBe("inactive");
      // Historical FKs stay — deactivated users are never hard-deleted.
      expect(row.manager_id).toBe(f.ids.manager);

      // Every session revoked: the cached access token is dead NOW (durable
      // revoke, not just the status check).
      expect(
        ((await f.api("member").get("/api/v1/auth/me")) as unknown as TestResponse)
          .status,
      ).toBe(401);
      const sessions = await f
        .db("auth_session")
        .where({ user_id: f.ids.member })
        .whereNull("revoked_at");
      expect(sessions).toHaveLength(0);

      const audit = await f
        .db("audit_event")
        .where({
          action: "user.deactivate",
          request_id: res.headers["x-request-id"],
        })
        .first();
      expect(audit).toMatchObject({
        actor_id: f.ids.admin,
        target_type: "app_user",
        target_id: f.ids.member,
        outcome: "success",
      });

      // Idempotent: a second deactivate is a clean no-op, not an error.
      expect((await deactivate(f, "admin", f.ids.member)).status).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("admin cannot deactivate owner/admin accounts — including itself (403)", async () => {
    const f = await fixture({ seeded: true });
    try {
      expect((await deactivate(f, "admin", f.ids.owner)).status).toBe(403);
      expect((await deactivate(f, "admin", f.ids.admin)).status).toBe(403);
      // Members/managers cannot deactivate anyone; anonymous 401.
      for (const p of ["member", "manager", "outsider"] as Persona[]) {
        expect((await deactivate(f, p, f.ids.outsider)).status, p).toBe(403);
      }
      expect((await deactivate(f, undefined, f.ids.member)).status).toBe(401);
      // Everyone still active.
      const rows = await f.db("app_user").where({ status: "active" });
      expect(rows).toHaveLength(5);
    } finally {
      await f.close();
    }
  });

  it("deactivating a user with active reports requires the owner to reassign them — same transaction", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Admin may not touch a manager that still has reports — deactivating
      // would reshape the tree, which is owner territory (spec §3).
      expect((await deactivate(f, "admin", f.ids.manager)).status).toBe(403);

      // Owner must decide the reports' new line: no key → 403.
      const missing = await deactivate(f, "owner", f.ids.manager);
      expect(missing.status).toBe(403);
      expect(missing.body.code).toBe("REPORTS_UNASSIGNED");

      // member still reports to manager; manager still active.
      const before = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(before.manager_id).toBe(f.ids.manager);

      // With a replacement, reports transfer in the same transaction.
      const moved = await deactivate(f, "owner", f.ids.manager, {
        replacementManagerId: f.ids.outsider,
      });
      expect(moved.status).toBe(200);
      expect(moved.body.status).toBe("inactive");
      const member = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(member.manager_id).toBe(f.ids.outsider);

      // The deactivated manager's sessions are dead — old token → 401.
      expect(
        (
          (await f
            .api("manager")
            .get("/api/v1/auth/me")) as unknown as TestResponse
        ).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("owner may hand reports to nobody (explicit null) but the replacement must be a real active user", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Unknown replacement → 404.
      expect(
        (
          await deactivate(f, "owner", f.ids.manager, {
            replacementManagerId: randomUUID(),
          })
        ).status,
      ).toBe(404);
      // The target itself is not a replacement.
      expect(
        (
          await deactivate(f, "owner", f.ids.manager, {
            replacementManagerId: f.ids.manager,
          })
        ).status,
      ).toBe(400);
      // A replacement inside the target's subtree would close a cycle → 409.
      expect(
        (
          await deactivate(f, "owner", f.ids.manager, {
            replacementManagerId: f.ids.member,
          })
        ).status,
      ).toBe(409);
      // An inactive replacement cannot take reports.
      await f
        .db("app_user")
        .where({ id: f.ids.outsider })
        .update({ status: "inactive" });
      expect(
        (
          await deactivate(f, "owner", f.ids.manager, {
            replacementManagerId: f.ids.outsider,
          })
        ).status,
      ).toBe(409);

      // Explicit null: reports move to "unassigned" in the same transaction.
      const res = await deactivate(f, "owner", f.ids.manager, {
        replacementManagerId: null,
      });
      expect(res.status).toBe(200);
      const member = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(member.manager_id).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("dormant reports still need the owner's decision — admin may not rewrite the edges (§3)", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Leave manager with only a DORMANT report: member is deactivated
      // first (a leaf — admin may do that).
      expect((await deactivate(f, "admin", f.ids.member)).status).toBe(200);

      // "có cấp dưới" is not status-qualified: a missing decision key →
      // 403 REPORTS_UNASSIGNED exactly like the active branch — a dormant
      // edge may not be stranded on an inactive manager.
      const missing = await deactivate(f, "owner", f.ids.manager);
      expect(missing.status).toBe(403);
      expect(missing.body.code).toBe("REPORTS_UNASSIGNED");

      // Admin may not reshape the tree even indirectly — blocked bare,
      // and blocked from supplying the manager_id rewrite itself.
      expect((await deactivate(f, "admin", f.ids.manager)).status).toBe(
        403,
      );
      expect(
        (
          await deactivate(f, "admin", f.ids.manager, {
            replacementManagerId: f.ids.outsider,
          })
        ).status,
      ).toBe(403);

      // Every denial was atomic — member still reports to manager.
      const before = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(before.manager_id).toBe(f.ids.manager);

      // Explicit null unassigns the dormant edge in the same transaction.
      const res = await deactivate(f, "owner", f.ids.manager, {
        replacementManagerId: null,
      });
      expect(res.status).toBe(200);
      const member = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(member.manager_id).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("validates a dormant-edge replacement fully — self 400, inactive 409, subtree descendant 409", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Same setup — member becomes manager's dormant report.
      expect((await deactivate(f, "admin", f.ids.member)).status).toBe(200);

      // Self is rejected even though the target is still "active" at
      // decision time; unknown → 404; the dormant report itself is an
      // inactive replacement → 409 USER_NOT_ACTIVE.
      expect(
        (
          await deactivate(f, "owner", f.ids.manager, {
            replacementManagerId: f.ids.manager,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await deactivate(f, "owner", f.ids.manager, {
            replacementManagerId: randomUUID(),
          })
        ).status,
      ).toBe(404);
      const inactive = await deactivate(f, "owner", f.ids.manager, {
        replacementManagerId: f.ids.member,
      });
      expect(inactive.status).toBe(409);
      expect(inactive.body.code).toBe("USER_NOT_ACTIVE");

      // An ACTIVE descendant hiding under the dormant edge would close a
      // real cycle — graft outsider under member (direct write: the API
      // never creates an edge to an inactive manager, so only dirty state
      // like this exercises the check on a dormant-only report set).
      await f
        .db("app_user")
        .where({ id: f.ids.outsider })
        .update({ manager_id: f.ids.member });
      const cycle = await deactivate(f, "owner", f.ids.manager, {
        replacementManagerId: f.ids.outsider,
      });
      expect(cycle.status).toBe(409);
      expect(cycle.body.code).toBe("REPORTING_CYCLE");

      // A legal replacement takes the dormant edge too — no manager_id is
      // left pointing at the deactivated account.
      const moved = await deactivate(f, "owner", f.ids.manager, {
        replacementManagerId: f.ids.admin,
      });
      expect(moved.status).toBe(200);
      const member = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(member.manager_id).toBe(f.ids.admin);
    } finally {
      await f.close();
    }
  });

  it("admin still gets 403 re-deactivating an already-inactive privileged target", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Inactive ADMIN: member promoted, then deactivated by owner.
      await grantRoles(f, f.ids.member, ["member", "admin"]);
      expect((await deactivate(f, "owner", f.ids.member)).status).toBe(200);
      // Inactive OWNER: outsider promoted, then deactivated by owner.
      await grantRoles(f, f.ids.outsider, ["member", "owner"]);
      expect((await deactivate(f, "owner", f.ids.outsider)).status).toBe(
        200,
      );

      // The privileged-target check precedes the idempotent no-op: admin
      // gets 403, not the already-inactive 200.
      expect((await deactivate(f, "admin", f.ids.member)).status).toBe(403);
      expect((await deactivate(f, "admin", f.ids.outsider)).status).toBe(
        403,
      );

      // Owner re-deactivating the same targets stays the idempotent 200.
      expect((await deactivate(f, "owner", f.ids.member)).status).toBe(200);
      expect((await deactivate(f, "owner", f.ids.outsider)).status).toBe(
        200,
      );
    } finally {
      await f.close();
    }
  });

  it("admin may deactivate a manager once the reports are gone; owner can deactivate non-last owners/admins", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Re-line member under owner first — manager now has zero reports.
      const move = await f
        .api("owner")
        .put(`/api/v1/users/${f.ids.member}/manager`)
        .send({ managerId: f.ids.owner });
      expect(move.status).toBe(200);
      expect((await deactivate(f, "admin", f.ids.manager)).status).toBe(200);

      // Owner deactivates admin — admin is privileged but owner outranks it.
      expect((await deactivate(f, "owner", f.ids.admin)).status).toBe(200);

      // And a second owner: promote outsider, deactivate as owner → allowed.
      await grantRoles(f, f.ids.outsider, ["member", "owner"]);
      expect((await deactivate(f, "owner", f.ids.outsider)).status).toBe(200);
      // The outsider's sessions were revoked too.
      expect(
        (
          (await f
            .api("outsider")
            .get("/api/v1/auth/me")) as unknown as TestResponse
        ).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("refuses to deactivate the last ACTIVE owner (409 LAST_OWNER)", async () => {
    const f = await fixture({ seeded: true });
    try {
      // owner still has active reports (manager, outsider) — the reports
      // decision must be satisfied before LAST_OWNER is even reached, so
      // supply a legal replacement; the rolled-back tx must leave the tree
      // untouched too.
      const res = await deactivate(f, "owner", f.ids.owner, {
        replacementManagerId: f.ids.admin,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("LAST_OWNER");
      const row = await f.db("app_user").where({ id: f.ids.owner }).first();
      expect(row.status).toBe("active");
      // The report transfer ran inside the same transaction — LAST_OWNER
      // rolled the whole thing back, so manager still reports to owner.
      const manager = await f
        .db("app_user")
        .where({ id: f.ids.manager })
        .first();
      expect(manager.manager_id).toBe(f.ids.owner);
    } finally {
      await f.close();
    }
  });

  it("serializes two concurrent owner deactivations — exactly one succeeds", async () => {
    const f = await fixture({ seeded: true });
    try {
      await grantRoles(f, f.ids.outsider, ["member", "owner"]);
      // Each owner deactivates THEMSELF (the winner's actor keeps no owner
      // role afterwards, so cross-deactivation would 403 instead). owner
      // still has active reports → replacement is required; outsider has
      // none.
      const [a, b] = await Promise.all([
        deactivate(f, "owner", f.ids.owner, {
          replacementManagerId: f.ids.admin,
        }),
        deactivate(f, "outsider", f.ids.outsider),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe("LAST_OWNER");

      const survivors = await f
        .db("app_user")
        .join("user_role", function () {
          this.on("user_role.user_id", "=", "app_user.id").andOn(
            "user_role.company_id",
            "=",
            "app_user.company_id",
          );
        })
        .join("role", "role.id", "user_role.role_id")
        .where({ "role.key": "owner", "app_user.status": "active" })
        .select("app_user.id");
      expect(survivors).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/users — company directory", () => {
  it("lists directory-safe fields for any authenticated member, keyset-paginated", async () => {
    const f = await fixture({ seeded: true });
    try {
      const page1 = (await f
        .api("member")
        .get("/api/v1/users?limit=2")) as unknown as TestResponse;
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).not.toBeNull();

      const seen: string[] = [];
      let cursor: string | null = page1.body.nextCursor as string;
      for (const item of page1.body.items as { id: string }[]) {
        seen.push(item.id);
      }
      while (cursor !== null) {
        const page = (await f
          .api("member")
          .get(`/api/v1/users?limit=2&cursor=${cursor}`)) as unknown as TestResponse;
        expect(page.status).toBe(200);
        for (const item of page.body.items as { id: string }[]) {
          seen.push(item.id);
        }
        cursor = page.body.nextCursor as string | null;
      }
      expect(seen.sort()).toEqual(
        [
          f.ids.owner,
          f.ids.admin,
          f.ids.manager,
          f.ids.member,
          f.ids.outsider,
        ].sort(),
      );

      // Directory-safe shape only — no credential/material fields.
      const sample = (page1.body.items as Record<string, unknown>[])[0];
      expect(sample).not.toHaveProperty("password_hash");
      expect(sample).not.toHaveProperty("auth_version");
      expect(sample).toHaveProperty("email");
      expect(sample).toHaveProperty("roles");
      expect(sample).toHaveProperty("status");
    } finally {
      await f.close();
    }
  });

  it("GET /api/v1/users/:id returns the same shape; unknown/foreign/malformed → 404; anonymous → 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      const res = (await f
        .api("member")
        .get(`/api/v1/users/${f.ids.manager}`)) as unknown as TestResponse;
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: f.ids.manager,
        email: personaEmail("manager"),
        status: "active",
        roles: ["manager"],
        managerId: f.ids.owner,
      });

      for (const id of [randomUUID(), f.ids.otherCompany, "not-a-uuid"]) {
        const missing = (await f
          .api("owner")
          .get(`/api/v1/users/${id}`)) as unknown as TestResponse;
        expect(missing.status, id).toBe(404);
      }
      expect(
        ((await f.api().get("/api/v1/users")) as unknown as TestResponse)
          .status,
      ).toBe(401);
      expect(
        (
          (await f
            .api()
            .get(`/api/v1/users/${f.ids.member}`)) as unknown as TestResponse
        ).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });
});
