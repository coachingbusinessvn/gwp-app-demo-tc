import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config.js";
import { assertDeploymentMode } from "../../server/src/db/deployment-state.js";
import { DEMO_SEED_VERSION, seedDemo } from "../../server/src/db/seed-demo.js";
import { verifyPassword } from "../../server/src/modules/auth/password.js";
import {
  DEMO_IDENTITIES,
  DEMO_PASSWORD,
  type DemoId,
} from "../fixtures/identities.js";
import { fixture, testEnv } from "../helpers/fixture.js";

const config = loadConfig(testEnv);

const input = {
  bootstrapToken: config.bootstrapToken,
  companyName: "GWP",
  email: "owner@example.test",
  password: "a-long-test-password-123!",
};

async function countRows(
  f: Awaited<ReturnType<typeof fixture>>,
  table: string,
): Promise<number> {
  const row = await f.db(table).count("* as n").first();
  return Number((row as { n: string }).n);
}

describe("POST /api/v1/setup", () => {
  it("parallel setup requests produce exactly one 201 and one 409", async () => {
    const f = await fixture({ seeded: false });
    try {
      const results = await Promise.all(
        [1, 2].map(() => f.api().post("/api/v1/setup").send(input)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await f.db("company").count("* as n").first()).toMatchObject({
        n: "1",
      });

      const created = results.find((r) => r.status === 201)!;
      // Setup returns identifiers only — never tokens.
      expect(Object.keys(created.body).sort()).toEqual([
        "companyId",
        "userId",
      ]);
      const rejected = results.find((r) => r.status === 409)!;
      expect(rejected.body.code).toBe("SETUP_CLOSED");

      // The winner produced an active owner with a usable password hash and
      // the owner role, and locked setup inside the same transaction.
      const owner = await f
        .db("app_user")
        .where({ id: created.body.userId })
        .first();
      expect(owner).toMatchObject({
        company_id: created.body.companyId,
        status: "active",
      });
      expect(await verifyPassword(owner.password_hash, input.password)).toBe(
        true,
      );
      const roles = await f
        .db("user_role")
        .join("role", "role.id", "user_role.role_id")
        .where({ "user_role.user_id": created.body.userId })
        .select("role.key");
      expect(roles.map((r: { key: string }) => r.key)).toEqual(["owner"]);

      const state = await f
        .db("deployment_state")
        .where({ singleton_id: 1 })
        .first();
      expect(state.setup_completed_at).not.toBeNull();

      const audits = await f
        .db("audit_event")
        .where({ action: "setup.bootstrap" })
        .orderBy("created_at")
        .select("outcome", "safe_metadata");
      // Winner audited success; the raced loser audited its 409.
      expect(audits).toHaveLength(2);
      expect(audits.map((a) => a.outcome).sort()).toEqual([
        "failure",
        "success",
      ]);
      const failure = audits.find((a) => a.outcome === "failure")!;
      expect(failure.safe_metadata).toMatchObject({
        error_code: "setup_closed",
      });
    } finally {
      await f.close();
    }
  });

  it("rejects a wrong or absent bootstrap token with the same generic 401", async () => {
    const f = await fixture({ seeded: false });
    try {
      const wrong = await f
        .api()
        .post("/api/v1/setup")
        .send({ ...input, bootstrapToken: "not-the-token" });
      const absent = await f.api().post("/api/v1/setup").send({
        companyName: input.companyName,
        email: input.email,
        password: input.password,
      });
      expect(wrong.status).toBe(401);
      expect(absent.status).toBe(401);
      // Same code+message for both — the response must not reveal which part
      // of the request failed.
      expect(wrong.body.code).toBe(absent.body.code);
      expect(wrong.body.message).toBe(absent.body.message);
      expect(await countRows(f, "company")).toBe(0);
      expect(await countRows(f, "app_user")).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("refuses a second setup after completion (409 SETUP_CLOSED) and audits the failure", async () => {
    const f = await fixture({ seeded: false });
    try {
      const first = await f.api().post("/api/v1/setup").send(input);
      expect(first.status).toBe(201);
      const second = await f
        .api()
        .post("/api/v1/setup")
        .send({ ...input, email: "other@example.test" });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe("SETUP_CLOSED");
      expect(await countRows(f, "company")).toBe(1);
      expect(await countRows(f, "app_user")).toBe(1);

      const audits = await f
        .db("audit_event")
        .where({ action: "setup.bootstrap" })
        .orderBy("created_at")
        .select("outcome", "safe_metadata", "request_id");
      expect(audits).toHaveLength(2);
      expect(audits[0].outcome).toBe("success");
      expect(audits[0].request_id).toBe(
        first.headers["x-request-id"],
      );
      expect(audits[1]).toMatchObject({
        outcome: "failure",
        safe_metadata: { error_code: "setup_closed" },
      });
    } finally {
      await f.close();
    }
  });

  it("refuses setup when deployment_state.mode does not match config.mode (409 MODE_MISMATCH)", async () => {
    const f = await fixture({ seeded: false, mode: "demo" });
    try {
      // Flip only the DB row — simulates a DB provisioned for a different mode.
      await f
        .db("deployment_state")
        .where({ singleton_id: 1 })
        .update({ mode: "production" });
      const res = await f.api().post("/api/v1/setup").send(input);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("MODE_MISMATCH");
      expect(await countRows(f, "company")).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("rate-limits setup by IP after 10 requests per minute", async () => {
    const f = await fixture({ seeded: false });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await f
          .api()
          .post("/api/v1/setup")
          .send({ ...input, bootstrapToken: "wrong" });
        expect(res.status).toBe(401);
      }
      const limited = await f
        .api()
        .post("/api/v1/setup")
        .send({ ...input, bootstrapToken: "wrong" });
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("RATE_LIMITED");
    } finally {
      await f.close();
    }
  });
});

describe("deployment mode guard", () => {
  it("assertDeploymentMode refuses a restart against a mismatched database", async () => {
    const f = await fixture({ seeded: false, mode: "demo" });
    try {
      const productionConfig = loadConfig({
        ...testEnv,
        DEMO_MODE: "production",
      });
      await expect(
        assertDeploymentMode(f.db, productionConfig),
      ).rejects.toThrow(/mode mismatch/i);
      await expect(
        assertDeploymentMode(f.db, loadConfig(testEnv)),
      ).resolves.toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

describe("seedDemo", () => {
  it("refuses on a production deployment even after setup completed", async () => {
    const f = await fixture({ seeded: false, mode: "production" });
    try {
      const res = await f.api().post("/api/v1/setup").send(input);
      expect(res.status).toBe(201);
      await expect(seedDemo(f.db, "demo")).rejects.toMatchObject({
        code: "MODE_MISMATCH",
      });
      // Only the bootstrap owner exists — no demo identities leaked into a
      // production schema.
      expect(await countRows(f, "app_user")).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("refuses when setup has not completed yet", async () => {
    const f = await fixture({ seeded: false });
    try {
      await expect(seedDemo(f.db, "demo")).rejects.toMatchObject({
        code: "SETUP_REQUIRED",
      });
      expect(await countRows(f, "app_user")).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("seeds the demo org wired by manager_id, then a second run is a no-op", async () => {
    const f = await fixture({ seeded: false });
    try {
      const res = await f.api().post("/api/v1/setup").send(input);
      expect(res.status).toBe(201);

      await seedDemo(f.db, "demo");

      const state = await f
        .db("deployment_state")
        .where({ singleton_id: 1 })
        .first();
      expect(state.seed_version).toBe(DEMO_SEED_VERSION);

      // 10 demo identities + the bootstrap owner.
      const users = await f.db("app_user").select("*");
      expect(users).toHaveLength(11);

      const byDemoId = new Map<DemoId, { id: string; manager_id: string | null; password_hash: string }>();
      for (const [demoId, ident] of Object.entries(DEMO_IDENTITIES)) {
        const row = users.find(
          (u: { email: string }) => u.email === ident.email,
        );
        expect(row, `demo user ${demoId}`).toMatchObject({
          id: ident.demoUserId,
          name: ident.name,
          title: ident.title,
          status: "active",
        });
        byDemoId.set(demoId as DemoId, row);
      }

      // Reporting lines follow the ORG tree, not names.
      for (const [demoId, ident] of Object.entries(DEMO_IDENTITIES)) {
        const row = byDemoId.get(demoId as DemoId)!;
        const expectedManager = ident.managerDemoId
          ? byDemoId.get(ident.managerDemoId)!.id
          : null;
        expect(row.manager_id, `manager of ${demoId}`).toBe(expectedManager);
      }

      // Roles: l1 owner, level-2 managers, level-3 members.
      const roleByUser = new Map<string, string>();
      const rows = await f
        .db("user_role")
        .join("role", "role.id", "user_role.role_id")
        .select("user_role.user_id", "role.key");
      for (const r of rows) roleByUser.set(r.user_id, r.key);
      for (const [demoId, ident] of Object.entries(DEMO_IDENTITIES)) {
        expect(roleByUser.get(byDemoId.get(demoId as DemoId)!.id)).toBe(
          ident.role,
        );
      }

      // Published demo password really verifies (argon2id hash).
      const l1 = byDemoId.get("l1")!;
      expect(await verifyPassword(l1.password_hash, DEMO_PASSWORD)).toBe(true);
      expect(
        await verifyPassword(l1.password_hash, "wrong-password"),
      ).toBe(false);

      const seedAudit = await f
        .db("audit_event")
        .where({ action: "demo.seed" })
        .first();
      expect(seedAudit).toMatchObject({ outcome: "success" });

      // Second run: version-skip — no new rows, seed_version unchanged.
      await seedDemo(f.db, "demo");
      expect(await countRows(f, "app_user")).toBe(11);
      const after = await f
        .db("deployment_state")
        .where({ singleton_id: 1 })
        .first();
      expect(after.seed_version).toBe(DEMO_SEED_VERSION);
    } finally {
      await f.close();
    }
  });
});
