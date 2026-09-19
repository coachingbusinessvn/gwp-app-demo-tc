import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config.js";
import {
  FIXTURE_PASSWORD,
  fixture,
  personaEmail,
  TEST_DATABASE_URL,
  testEnv,
  type Fixture,
  type Persona,
} from "../helpers/fixture.js";

/**
 * Task 1.4 — one-time credential tokens + owner recovery (spec §8/§9):
 *
 *   POST /api/v1/users/:id/credential-token — owner only; issues a 24h
 *     one-time token for purpose activate (pending users) or reset
 *     (active users). The raw token is returned ONCE — the DB stores
 *     only its SHA-256 hex digest.
 *   POST /api/v1/auth/activate | /reset — public consume; a single
 *     INVALID_TOKEN 400 covers unknown/expired/used/wrong-purpose
 *     tokens. Consume sets the password, flips pending→active and
 *     revokes every existing session — it never logs the user in.
 *   POST /api/v1/auth/password — self-service change; verifies the
 *     current password, then revokes ALL sessions including the
 *     caller's own.
 *   owner:recover CLI — stdin password prompt, DEMO_MODE ↔
 *     deployment_state.mode check, --confirm-deployment guard.
 */
const config = loadConfig(testEnv);
const ORIGIN = testEnv.APP_ORIGIN as string;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI_ENTRY = "server/src/cli/recover-owner.ts";
const NEW_PASSWORD = "new-long-password-2026!";

type TestResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};

function issue(
  f: Fixture,
  persona: Persona | undefined,
  userId: string,
  purpose: string,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(`/api/v1/users/${userId}/credential-token`)
    .send({ purpose }) as unknown as Promise<TestResponse>;
}

function consume(
  f: Fixture,
  kind: "activate" | "reset",
  token: string,
  password: string,
): Promise<TestResponse> {
  return f
    .api()
    .post(`/api/v1/auth/${kind}`)
    .send({ token, password }) as unknown as Promise<TestResponse>;
}

function login(
  f: Fixture,
  email: string,
  password: string,
): Promise<TestResponse> {
  return request(f.app)
    .post("/api/v1/auth/login")
    .set("Origin", ORIGIN)
    .send({ email, password }) as unknown as Promise<TestResponse>;
}

function me(f: Fixture, accessToken: string): Promise<TestResponse> {
  return request(f.app)
    .get("/api/v1/auth/me")
    .auth(accessToken, { type: "bearer" }) as unknown as Promise<TestResponse>;
}

async function createPendingUser(f: Fixture, email: string): Promise<string> {
  const res = await f
    .api("admin")
    .post("/api/v1/users")
    .send({ email, name: "Pending User" });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

const sha256hex = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

async function currentSchema(f: Fixture): Promise<string> {
  const rows = await f.db.raw("select current_schema() as s");
  return rows.rows[0].s as string;
}

/**
 * DATABASE_URL variant pinned to the fixture's isolated schema — the pg
 * `options` startup parameter applies `-c search_path=...` per connection.
 */
function cliUrl(schema: string): string {
  return `${TEST_DATABASE_URL}?options=-c%20search_path%3D${schema}`;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    input,
    timeout: 120_000,
  });
  if (res.error) throw res.error;
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("POST /api/v1/users/:id/credential-token", () => {
  it("owner issues a token shown once — the DB stores only its SHA-256 hash", async () => {
    const f = await fixture({ seeded: true });
    try {
      const r = await issue(f, "owner", f.ids.member, "reset");
      expect(r.status).toBe(201);
      const token = r.body.token as string;
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThanOrEqual(32);
      const expiresAt = new Date(r.body.expiresAt as string);
      const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThan(25);

      // Full-row dump: the raw token appears NOWHERE — only its hash.
      const rows = await f.db("one_time_token").select("*");
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]).toMatchObject({
        company_id: f.ids.company,
        user_id: f.ids.member,
        purpose: "reset",
        used_at: null,
        created_by: f.ids.owner,
      });
      expect(rows[0].token_hash).toBe(sha256hex(token));
      expect(rows[0].token_hash).not.toBe(token);

      // Issuance is audited with the real actor.
      const audit = await f
        .db("audit_event")
        .where({
          action: "credential.issue",
          request_id: r.headers["x-request-id"],
        })
        .first();
      expect(audit).toMatchObject({
        actor_id: f.ids.owner,
        target_type: "app_user",
        target_id: f.ids.member,
        outcome: "success",
      });
      // The audit row must not carry the token either.
      expect(JSON.stringify(audit)).not.toContain(token);
    } finally {
      await f.close();
    }
  });

  it("is owner-only — admin/manager/member 403, owner self-issuance 403, anonymous 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      // The brief's literal case: admin may never mint an account-taking
      // token — not even for a plain member.
      expect((await issue(f, "admin", f.ids.member, "reset")).status).toBe(
        403,
      );
      for (const p of ["manager", "member", "outsider"] as Persona[]) {
        const res = await issue(f, p, f.ids.member, "reset");
        expect(res.status, p).toBe(403);
      }
      // Self-issuance is refused: self-service is the password-change
      // endpoint — an owner must not mint a takeover token for itself.
      expect((await issue(f, "owner", f.ids.owner, "reset")).status).toBe(
        403,
      );
      expect(
        (await issue(f, undefined, f.ids.member, "reset")).status,
      ).toBe(401);

      // Unknown/cross-company/malformed targets → 404; bad purpose → 400.
      expect((await issue(f, "owner", randomUUID(), "reset")).status).toBe(
        404,
      );
      expect(
        (await issue(f, "owner", f.ids.otherCompany, "reset")).status,
      ).toBe(404);
      expect((await issue(f, "owner", "not-a-uuid", "reset")).status).toBe(
        404,
      );
      expect((await issue(f, "owner", f.ids.member, "bogus")).status).toBe(
        400,
      );
    } finally {
      await f.close();
    }
  });

  it("binds purpose to the target's status — activate needs pending, reset needs active", async () => {
    const f = await fixture({ seeded: true });
    try {
      // activate on an already-active member → 409.
      const wrongPurpose = await issue(f, "owner", f.ids.member, "activate");
      expect(wrongPurpose.status).toBe(409);
      expect(wrongPurpose.body.code).toBe("USER_NOT_PENDING");

      // reset on a pending user → 409.
      const pendingId = await createPendingUser(f, "pending-1@example.test");
      const resetOnPending = await issue(f, "owner", pendingId, "reset");
      expect(resetOnPending.status).toBe(409);
      expect(resetOnPending.body.code).toBe("USER_NOT_ACTIVE");

      // activate on the pending user is the happy path.
      expect((await issue(f, "owner", pendingId, "activate")).status).toBe(
        201,
      );
    } finally {
      await f.close();
    }
  });

  it("a fresh issuance supersedes the previous unused token of the same purpose", async () => {
    const f = await fixture({ seeded: true });
    try {
      const first = await issue(f, "owner", f.ids.member, "reset");
      const second = await issue(f, "owner", f.ids.member, "reset");
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.token).not.toBe(first.body.token);

      // The superseded token reads exactly like an unknown one.
      const stale = await consume(
        f,
        "reset",
        first.body.token as string,
        NEW_PASSWORD,
      );
      expect(stale.status).toBe(400);
      expect(stale.body.code).toBe("INVALID_TOKEN");

      // The live one still works.
      expect(
        (await consume(f, "reset", second.body.token as string, NEW_PASSWORD))
          .status,
      ).toBe(204);
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/auth/activate", () => {
  it("flips pending → active with the chosen password — and does NOT log the user in", async () => {
    const f = await fixture({ seeded: true });
    try {
      const pendingId = await createPendingUser(f, "activate-me@example.test");
      // Pending accounts cannot authenticate before activation.
      expect(
        (await login(f, "activate-me@example.test", "whatever-password"))
          .status,
      ).toBe(401);

      const issued = await issue(f, "owner", pendingId, "activate");
      expect(issued.status).toBe(201);
      const res = await consume(
        f,
        "activate",
        issued.body.token as string,
        NEW_PASSWORD,
      );
      expect(res.status).toBe(204);
      // No session material: no body, no cookies — login is a separate act.
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body).toEqual({});

      const row = await f
        .db("app_user")
        .where({ id: pendingId })
        .first();
      expect(row.status).toBe("active");
      expect(row.password_hash).toBeTruthy();
      expect(row.password_hash).not.toContain(NEW_PASSWORD);
      expect(row.auth_version).toBe(1);

      // The chosen password works at the real login endpoint.
      const logged = await login(f, "activate-me@example.test", NEW_PASSWORD);
      expect(logged.status).toBe(200);
      expect(logged.body.user).toMatchObject({ id: pendingId });
    } finally {
      await f.close();
    }
  });

  it("returns the SAME INVALID_TOKEN 400 for unknown, used, expired and wrong-purpose tokens", async () => {
    const f = await fixture({ seeded: true });
    try {
      const pendingId = await createPendingUser(f, "tok@example.test");
      const issued = await issue(f, "owner", pendingId, "activate");
      const token = issued.body.token as string;

      const unknown = await consume(f, "activate", "not-a-real-token", NEW_PASSWORD);
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe("INVALID_TOKEN");

      // First consume wins; replay is indistinguishable from garbage.
      expect((await consume(f, "activate", token, NEW_PASSWORD)).status).toBe(
        204,
      );
      const reused = await consume(f, "activate", token, "another-pass-9999");
      expect(reused.status).toBe(400);
      expect(reused.body.code).toBe("INVALID_TOKEN");
      expect(reused.body.message).toBe(unknown.body.message);

      // Expired: same 400/INVALID_TOKEN/same message.
      const second = await issue(f, "owner", f.ids.member, "reset");
      await f
        .db("one_time_token")
        .where({ token_hash: sha256hex(second.body.token as string) })
        .update({ expires_at: new Date(Date.now() - 60_000) });
      const expired = await consume(
        f,
        "reset",
        second.body.token as string,
        NEW_PASSWORD,
      );
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe("INVALID_TOKEN");
      expect(expired.body.message).toBe(unknown.body.message);

      // Purpose is bound to the endpoint: a reset token presented to
      // /activate reads as INVALID_TOKEN too (and stays unconsumed).
      const third = await issue(f, "owner", f.ids.outsider, "reset");
      const wrongPurpose = await consume(
        f,
        "activate",
        third.body.token as string,
        NEW_PASSWORD,
      );
      expect(wrongPurpose.status).toBe(400);
      expect(wrongPurpose.body.code).toBe("INVALID_TOKEN");

      // Body validation is a different 400 — a weak new password never
      // consumes the token.
      const weak = await consume(
        f,
        "reset",
        third.body.token as string,
        "short",
      );
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe("INVALID_INPUT");
      expect(
        (await consume(f, "reset", third.body.token as string, NEW_PASSWORD))
          .status,
      ).toBe(204);
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/auth/reset", () => {
  it("sets the new password and revokes EVERY existing session without logging in", async () => {
    const f = await fixture({ seeded: true });
    try {
      // member now holds two live sessions: the fixture login + this one.
      const extra = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      expect(extra.status).toBe(200);
      const extraAccess = extra.body.accessToken as string;

      const issued = await issue(f, "owner", f.ids.member, "reset");
      const res = await consume(
        f,
        "reset",
        issued.body.token as string,
        NEW_PASSWORD,
      );
      expect(res.status).toBe(204);
      expect(res.headers["set-cookie"]).toBeUndefined();

      // Durable revoke: both sessions are dead on the very next request.
      expect((await me(f, extraAccess)).status).toBe(401);
      expect(
        ((await f.api("member").get("/api/v1/auth/me")) as unknown as TestResponse)
          .status,
      ).toBe(401);
      const sessions = await f
        .db("auth_session")
        .where({ user_id: f.ids.member })
        .select("revoked_at");
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      for (const s of sessions) expect(s.revoked_at).not.toBeNull();

      // Old password is dead; the new one logs in.
      expect((await login(f, personaEmail("member"), FIXTURE_PASSWORD)).status).toBe(
        401,
      );
      expect((await login(f, personaEmail("member"), NEW_PASSWORD)).status).toBe(
        200,
      );

      const audit = await f
        .db("audit_event")
        .where({
          action: "credential.reset",
          request_id: res.headers["x-request-id"],
        })
        .first();
      expect(audit).toMatchObject({
        outcome: "success",
        target_id: f.ids.member,
      });
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/auth/password", () => {
  it("verifies the current password and revokes ALL sessions including the caller's", async () => {
    const f = await fixture({ seeded: true });
    try {
      const extra = await login(f, personaEmail("member"), FIXTURE_PASSWORD);
      const extraAccess = extra.body.accessToken as string;

      // Wrong current password → 400 INVALID_CREDENTIALS; nothing changes.
      const wrong = await f
        .api("member")
        .post("/api/v1/auth/password")
        .send({
          currentPassword: "nope-nope-nope",
          newPassword: "replacement-pass-12",
        });
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe("INVALID_CREDENTIALS");

      // Weak new password → INVALID_INPUT 400.
      const weak = (await f
        .api("member")
        .post("/api/v1/auth/password")
        .send({ currentPassword: FIXTURE_PASSWORD, newPassword: "short" })) as unknown as TestResponse;
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe("INVALID_INPUT");

      // Anonymous → 401.
      expect(
        (
          (await f
            .api()
            .post("/api/v1/auth/password")
            .send({
              currentPassword: FIXTURE_PASSWORD,
              newPassword: "replacement-pass-12",
            })) as unknown as TestResponse
        ).status,
      ).toBe(401);

      const ok = (await f
        .api("member")
        .post("/api/v1/auth/password")
        .send({
          currentPassword: FIXTURE_PASSWORD,
          newPassword: "replacement-pass-12",
        })) as unknown as TestResponse;
      expect(ok.status).toBe(204);

      // The caller's own session dies too — re-login is mandatory.
      expect(
        ((await f.api("member").get("/api/v1/auth/me")) as unknown as TestResponse)
          .status,
      ).toBe(401);
      expect((await me(f, extraAccess)).status).toBe(401);
      const sessions = await f
        .db("auth_session")
        .where({ user_id: f.ids.member })
        .select("revoked_at");
      for (const s of sessions) expect(s.revoked_at).not.toBeNull();

      const row = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(row.auth_version).toBe(1);
      expect((await login(f, personaEmail("member"), FIXTURE_PASSWORD)).status).toBe(
        401,
      );
      expect(
        (await login(f, personaEmail("member"), "replacement-pass-12")).status,
      ).toBe(200);
    } finally {
      await f.close();
    }
  });
});

describe("owner:recover CLI (spec §8 — operator-only, no public bypass)", () => {
  it("refuses when DEMO_MODE disagrees with the database's deployment_state.mode", async () => {
    const f = await fixture({ seeded: true, mode: "production" });
    try {
      const schema = await currentSchema(f);
      const res = runCli(
        [
          "--email",
          personaEmail("owner"),
          "--confirm-deployment",
          f.ids.company,
        ],
        {
          ...process.env,
          DATABASE_URL: cliUrl(schema),
          DEMO_MODE: "demo", // DB is production — must refuse.
        },
        "cli-pass-12345\n",
      );
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toMatch(/mode/i);
    } finally {
      await f.close();
    }
  });

  it("refuses a non-owner email and a wrong --confirm-deployment id", async () => {
    const f = await fixture({ seeded: true });
    try {
      const schema = await currentSchema(f);
      const env = {
        ...process.env,
        DATABASE_URL: cliUrl(schema),
        DEMO_MODE: "demo",
      };

      const nonOwner = runCli(
        [
          "--email",
          personaEmail("member"),
          "--confirm-deployment",
          f.ids.company,
        ],
        env,
        "cli-pass-12345\n",
      );
      expect(nonOwner.status).not.toBe(0);
      expect(nonOwner.stderr + nonOwner.stdout).toMatch(/owner/i);

      const badConfirm = runCli(
        [
          "--email",
          personaEmail("owner"),
          "--confirm-deployment",
          randomUUID(),
        ],
        env,
        "cli-pass-12345\n",
      );
      expect(badConfirm.status).not.toBe(0);
      expect(badConfirm.stderr + badConfirm.stdout).toMatch(/confirm/i);

      const ghost = runCli(
        [
          "--email",
          "ghost@example.test",
          "--confirm-deployment",
          f.ids.company,
        ],
        env,
        "cli-pass-12345\n",
      );
      expect(ghost.status).not.toBe(0);

      // A non-owner refused run must not have touched anything.
      const row = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(row.auth_version).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("recovers the owner: argon2 hash set, auth_version bumped, sessions revoked, audit written — password never echoed", async () => {
    const f = await fixture({ seeded: true });
    try {
      const schema = await currentSchema(f);
      const newPassword = "cli-recovered-pass-9";
      const res = runCli(
        [
          "--email",
          personaEmail("owner"),
          "--confirm-deployment",
          f.ids.company,
        ],
        {
          ...process.env,
          DATABASE_URL: cliUrl(schema),
          DEMO_MODE: "demo",
        },
        `${newPassword}\n`,
      );
      expect(res.status, res.stderr + res.stdout).toBe(0);
      // The password is never printed back or leaked to output.
      expect(res.stdout).not.toContain(newPassword);
      expect(res.stderr).not.toContain(newPassword);

      const row = await f.db("app_user").where({ id: f.ids.owner }).first();
      expect(row.status).toBe("active");
      expect(row.auth_version).toBe(1);
      expect(row.password_hash).not.toContain(newPassword);

      // Every prior owner session is dead.
      expect(
        ((await f.api("owner").get("/api/v1/auth/me")) as unknown as TestResponse)
          .status,
      ).toBe(401);
      const sessions = await f
        .db("auth_session")
        .where({ user_id: f.ids.owner })
        .select("revoked_at");
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      for (const s of sessions) expect(s.revoked_at).not.toBeNull();

      const audit = await f
        .db("audit_event")
        .where({ action: "credential.owner_recovery" })
        .first();
      expect(audit).toMatchObject({
        outcome: "success",
        target_type: "app_user",
        target_id: f.ids.owner,
      });
      expect(JSON.stringify(audit)).not.toContain(newPassword);

      // Old password dead; recovered password works.
      expect((await login(f, personaEmail("owner"), FIXTURE_PASSWORD)).status).toBe(
        401,
      );
      expect((await login(f, personaEmail("owner"), newPassword)).status).toBe(
        200,
      );
    } finally {
      await f.close();
    }
  });
});
