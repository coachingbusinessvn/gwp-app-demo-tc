import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb } from "../../server/src/db/connection.js";
import { migrate, migrationStatus } from "../../server/src/db/migrate.js";
import { appendAudit } from "../../server/src/modules/audit/service.js";
import { lockCompany } from "../../server/src/shared/company-lock.js";
import { AppError } from "../../server/src/shared/errors.js";
import {
  fixture,
  TEST_MIGRATOR_DATABASE_URL,
} from "../helpers/fixture.js";

const FOUNDATION_TABLES = [
  "company",
  "app_user",
  "role",
  "user_role",
  "setting",
  "deployment_state",
  "auth_session",
  "refresh_token",
  "audit_event",
  "schema_migration",
] as const;

describe("foundation schema (migration 0001)", () => {
  it("creates all foundation tables, seeds roles and the deployment singleton", async () => {
    const f = await fixture({ seeded: true });
    try {
      for (const table of FOUNDATION_TABLES) {
        expect(await f.db.schema.hasTable(table), table).toBe(true);
      }

      const roles = await f.db("role").select("key").orderBy("key");
      expect(roles.map((r: { key: string }) => r.key)).toEqual([
        "admin",
        "manager",
        "member",
        "owner",
      ]);

      const state = await f
        .db("deployment_state")
        .where({ singleton_id: 1 })
        .first();
      expect(state).toMatchObject({ mode: "demo", seed_version: 0 });

      const status = await migrationStatus(f.db);
      expect(status.applied).toEqual(["0001-foundation", "0002-organization"]);
      expect(status.pending).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("migrate() re-run is a no-op", async () => {
    const f = await fixture();
    try {
      const schema = (
        await f.db.raw("select current_schema() as s")
      ).rows[0].s as string;
      const migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
        searchPath: schema,
      });
      try {
        await migrate(migratorDb);
        const status = await migrationStatus(migratorDb);
        expect(status).toEqual({
          applied: ["0001-foundation", "0002-organization"],
          pending: [],
        });
        const count = await migratorDb("schema_migration")
          .count("* as n")
          .first();
        expect(count).toMatchObject({ n: "2" });
      } finally {
        await migratorDb.destroy();
      }
    } finally {
      await f.close();
    }
  });

  it("runtime role cannot run DDL — migrations only run on the migrator credential", async () => {
    const f = await fixture();
    try {
      await expect(
        f.db.schema.createTable("runtime_forbidden", (t) => {
          t.increments("id");
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await f.close();
    }
  });

  it("migrate() itself revokes runtime write on audit_event/schema_migration", async () => {
    // migrated:false skips the fixture's own post-migration grants/revokes, so
    // only migrate()'s enforcement (running as table owner) is under test.
    // Default privileges still gave runtime SELECT+INSERT+UPDATE+DELETE at
    // CREATE time — the revoke is what removes the write half.
    const f = await fixture({ migrated: false });
    try {
      const schema = (
        await f.db.raw("select current_schema() as s")
      ).rows[0].s as string;
      const migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
        searchPath: schema,
      });
      try {
        await migrate(migratorDb);
      } finally {
        await migratorDb.destroy();
      }

      expect(await f.db("audit_event").select("id")).toEqual([]);
      await expect(
        f.db("audit_event").update({ action: "tamper" }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.db("schema_migration").update({ name: "tamper" }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.db("schema_migration").insert({ name: "tamper" }),
      ).rejects.toMatchObject({ code: "42501" });
      // Runtime keeps SELECT on schema_migration — readiness probe needs it.
      expect(await f.db("schema_migration").select("name")).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
});

describe("company singleton", () => {
  it("blocks a second company row with a unique violation (23505)", async () => {
    const f = await fixture({ seeded: true });
    try {
      await expect(
        f
          .db("company")
          .insert({ id: randomUUID(), name: "Second", singleton: true }),
      ).rejects.toMatchObject({ code: "23505" });
      // Also blocked without the singleton flag — the index is the guard.
      await expect(
        f.db("company").insert({ name: "Second" }),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await f.close();
    }
  });
});

describe("app_user invariants", () => {
  it("normalizes email and enforces uniqueness per company (23505)", async () => {
    const f = await fixture({ seeded: true });
    try {
      const [inserted] = await f
        .db("app_user")
        .insert({
          company_id: f.ids.company,
          email: "  Owner@Test.Com ",
          name: "Owner",
          status: "pending",
        })
        .returning("id");
      const stored = await f
        .db("app_user")
        .where({ id: inserted.id })
        .first();
      expect(stored.email_normalized).toBe("owner@test.com");

      await expect(
        f.db("app_user").insert({
          company_id: f.ids.company,
          email: "owner@test.com",
          name: "Duplicate",
          status: "pending",
        }),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await f.close();
    }
  });

  it("rejects active user without password_hash but allows pending", async () => {
    const f = await fixture({ seeded: true });
    try {
      await expect(
        f.db("app_user").insert({
          company_id: f.ids.company,
          email: "active@example.test",
          name: "Active",
          status: "active",
        }),
      ).rejects.toMatchObject({ code: "23514" });

      await f.db("app_user").insert({
        company_id: f.ids.company,
        email: "pending@example.test",
        name: "Pending",
        status: "pending",
      });
      await f.db("app_user").insert({
        company_id: f.ids.company,
        email: "active@example.test",
        name: "Active",
        status: "active",
        password_hash: "$argon2id$test-hash",
      });
      // Scope to the rows this test inserted — seeded fixtures already hold
      // the five personas (task 0.4).
      const count = await f
        .db("app_user")
        .where({ company_id: f.ids.company })
        .whereIn("email_normalized", [
          "pending@example.test",
          "active@example.test",
        ])
        .count("* as n")
        .first();
      expect(count).toMatchObject({ n: "2" });
    } finally {
      await f.close();
    }
  });

  it("enforces the composite manager FK and rejects self-management", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Emails distinct from the seeded persona addresses (unique per company).
      const [manager] = await f
        .db("app_user")
        .insert({
          company_id: f.ids.company,
          email: "fk-manager@example.test",
          name: "Manager",
          status: "pending",
        })
        .returning("id");
      await f.db("app_user").insert({
        company_id: f.ids.company,
        email: "fk-member@example.test",
        name: "Member",
        status: "pending",
        manager_id: manager.id,
      });

      await expect(
        f.db("app_user").insert({
          company_id: f.ids.company,
          email: "orphan@example.test",
          name: "Orphan",
          status: "pending",
          manager_id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "23503" });

      const selfId = randomUUID();
      await expect(
        f.db("app_user").insert({
          id: selfId,
          company_id: f.ids.company,
          email: "self@example.test",
          name: "Self",
          status: "pending",
          manager_id: selfId,
        }),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await f.close();
    }
  });
});

describe("append-only audit", () => {
  async function seedActor(f: Awaited<ReturnType<typeof fixture>>) {
    const [user] = await f
      .db("app_user")
      .insert({
        company_id: f.ids.company,
        email: "actor@example.test",
        name: "Actor",
        status: "pending",
      })
      .returning("id");
    return user.id as string;
  }

  it("runtime can INSERT/SELECT audit_event but UPDATE/DELETE fail with 42501", async () => {
    const f = await fixture({ seeded: true });
    try {
      const actorId = await seedActor(f);
      await f.db.transaction(async (tx) => {
        await appendAudit(tx, {
          companyId: f.ids.company,
          actorId,
          action: "test.event",
          outcome: "success",
          requestId: randomUUID(),
          metadata: {},
        });
      });
      // Persona logins at fixture setup already wrote auth.login events —
      // scope the count to this test's action.
      expect(
        await f.db("audit_event").where({ action: "test.event" }).select("id"),
      ).toHaveLength(1);

      await expect(
        f.db("audit_event").update({ action: "tamper" }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(f.db("audit_event").delete()).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await f.close();
    }
  });

  it("appendAudit persists only allowlisted scalar metadata", async () => {
    const f = await fixture({ seeded: true });
    try {
      const actorId = await seedActor(f);
      const targetId = randomUUID();
      await f.db.transaction(async (tx) => {
        await appendAudit(tx, {
          companyId: f.ids.company,
          actorId,
          action: "user.role_granted",
          targetType: "app_user",
          targetId,
          outcome: "success",
          requestId: randomUUID(),
          metadata: {
            role: "manager",
            version: 2,
            reason: null,
            password_hash: "must-not-persist",
            nested: { no: "objects" },
            list: ["no", "arrays"],
            verbose: "x".repeat(500),
          },
        });
      });
      const row = await f
        .db("audit_event")
        .where({ action: "user.role_granted" })
        .first();
      expect(row).toMatchObject({
        company_id: f.ids.company,
        actor_id: actorId,
        action: "user.role_granted",
        target_type: "app_user",
        target_id: targetId,
        outcome: "success",
      });
      expect(row.safe_metadata).toEqual({
        role: "manager",
        version: 2,
        reason: null,
      });
    } finally {
      await f.close();
    }
  });
});

describe("company lock", () => {
  it("lockCompany takes FOR UPDATE on the row and 404s on unknown company", async () => {
    const f = await fixture({ seeded: true });
    try {
      await f.db.transaction(async (tx) => {
        await lockCompany(tx, f.ids.company);
      });
      await expect(
        f.db.transaction(async (tx) => {
          await lockCompany(tx, f.ids.otherCompany);
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: "COMPANY_NOT_FOUND",
      });
      await expect(
        f.db.transaction(async (tx) => {
          await lockCompany(tx, f.ids.otherCompany);
        }),
      ).rejects.toBeInstanceOf(AppError);
    } finally {
      await f.close();
    }
  });
});

describe("readiness with real migrations", () => {
  it("GET /health/ready returns 503 MIGRATIONS_PENDING on an unmigrated schema", async () => {
    const f = await fixture({ migrated: false });
    try {
      const res = await f.api().get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: "MIGRATIONS_PENDING",
        request_id: expect.any(String),
        details: { pending: ["0001-foundation", "0002-organization"] },
      });
    } finally {
      await f.close();
    }
  });
});
