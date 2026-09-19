import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Knex } from "knex";
import request, { type SuperTest, type Test } from "supertest";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { createDb } from "../../server/src/db/connection.js";
import { migrate } from "../../server/src/db/migrate.js";
import type { ActorContext, Id } from "../../server/src/shared/contracts.js";

export type Persona = "owner" | "admin" | "manager" | "member" | "outsider";

export interface Fixture {
  db: Knex;
  maintenanceDb: Knex;
  app: Express;
  ids: Record<Persona, Id> & { company: Id; otherCompany: Id };
  actor(persona: Persona): ActorContext;
  api(persona?: Persona): SuperTest<Test>;
  close(): Promise<void>;
}

/**
 * Test-only environment for loadConfig. Never reads process.env.DATABASE_URL —
 * tests may only ever reach the disposable gwp_test database.
 *
 * Credential split (task 0.2): f.db is the RUNTIME role (least privilege — no
 * DDL, audit append-only), migrations run on a separate gwp_migrator
 * connection that is destroyed afterwards, and maintenanceDb is the superuser
 * used only for create/drop schema and grants.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://gwp_runtime:gwp_runtime@127.0.0.1:54329/gwp_test";
export const TEST_MIGRATOR_DATABASE_URL =
  process.env.TEST_MIGRATOR_DATABASE_URL ??
  "postgres://gwp_migrator:gwp_migrator@127.0.0.1:54329/gwp_test";
export const TEST_MAINTENANCE_DATABASE_URL =
  process.env.TEST_MAINTENANCE_DATABASE_URL ??
  "postgres://gwp_test:gwp_test@127.0.0.1:54329/gwp_test";

export const testEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: "test-jwt-secret-0123456789abcdef0123456789",
  APP_KEY: "test-app-key-0123456789abcdef0123456789",
  BOOTSTRAP_TOKEN: "test-bootstrap-token-0123456789abcdef",
  DEMO_MODE: "demo",
  APP_ORIGIN: "https://gwp.test",
  PORT: "8080",
  TRUST_PROXY: "false",
};

const PERSONAS: readonly Persona[] = [
  "owner",
  "admin",
  "manager",
  "member",
  "outsider",
];

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/i;

function urlUser(url: string): string {
  const user = decodeURIComponent(new URL(url).username);
  if (!ROLE_NAME.test(user))
    throw new Error(`fixture: unsafe DB role name "${user}" in ${url}`);
  return user;
}

function assertTestDatabaseUrl(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName !== "gwp_test") {
    throw new Error(
      `fixture refuses to use database "${dbName}" — TEST_*_DATABASE_URL must point at gwp_test`,
    );
  }
}

async function assertConnectedToTestDb(db: Knex): Promise<void> {
  const { rows } = await db.raw("select current_database() as name");
  if (rows[0].name !== "gwp_test") {
    throw new Error(
      `fixture refuses to run against database "${rows[0].name}" — expected gwp_test`,
    );
  }
}

const AGENT_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

/**
 * Real-Postgres test fixture: unique schema per fixture() call (one per test
 * file/test), search_path isolation, real migrate() runner on the migrator
 * credential. Persona seeds and signed sessions arrive in tasks 0.3–0.4;
 * until then persona ids are freshly minted UUIDs and api(persona) attaches a
 * placeholder Bearer header. seeded:true inserts the single company row via
 * test-only SQL so ids.company is a real UUID; otherCompany stays a
 * nonexistent UUID for forged-input tests.
 *
 * migrated:false creates the schema and runtime connection but skips
 * migrations/grants — for readiness/probe tests that need a pending state.
 */
export async function fixture(options?: {
  seeded?: boolean;
  migrated?: boolean;
}): Promise<Fixture> {
  for (const url of [
    TEST_DATABASE_URL,
    TEST_MIGRATOR_DATABASE_URL,
    TEST_MAINTENANCE_DATABASE_URL,
  ]) {
    assertTestDatabaseUrl(url);
  }
  const migrated = options?.migrated ?? true;
  if (options?.seeded && !migrated)
    throw new Error("fixture: seeded requires a migrated schema");

  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const config = loadConfig(testEnv);
  const runtimeRole = urlUser(TEST_DATABASE_URL);
  const migratorRole = urlUser(TEST_MIGRATOR_DATABASE_URL);

  const maintenanceDb = createDb(TEST_MAINTENANCE_DATABASE_URL);
  await assertConnectedToTestDb(maintenanceDb);
  await maintenanceDb.raw(`CREATE SCHEMA "${schema}"`);

  let companyId: Id | undefined;
  try {
    // Schema-level grants before the migrator connects.
    await maintenanceDb.raw(
      `GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${migratorRole}"`,
    );
    await maintenanceDb.raw(
      `GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}", "gwp_maintenance"`,
    );

    if (migrated) {
      // migrate() never runs on the runtime connection — a dedicated migrator
      // credential applies pending migrations, then is destroyed.
      const migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
        searchPath: schema,
      });
      try {
        await migrate(migratorDb, { mode: config.mode });
        if (options?.seeded) {
          const inserted = await migratorDb("company")
            .insert({ name: "GWP Test Company" })
            .returning("id");
          companyId = (inserted[0] as { id: string }).id;
        }
      } finally {
        await migratorDb.destroy().catch(() => {});
      }

      // Table-level grants to runtime after migrations created the tables.
      // audit_event stays append-only (INSERT/SELECT); schema_migration is
      // read-only for the readiness probe.
      await maintenanceDb.raw(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeRole}"`,
      );
      await maintenanceDb.raw(
        `REVOKE UPDATE, DELETE ON TABLE "${schema}".audit_event FROM "${runtimeRole}"`,
      );
      await maintenanceDb.raw(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".schema_migration FROM "${runtimeRole}"`,
      );
      await maintenanceDb.raw(
        `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "gwp_maintenance"`,
      );
      await maintenanceDb.raw(
        `GRANT DELETE ON TABLE "${schema}".audit_event TO "gwp_maintenance"`,
      );
    }
  } catch (err) {
    await maintenanceDb
      .raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => {});
    await maintenanceDb.destroy().catch(() => {});
    throw err;
  }

  const db = createDb(TEST_DATABASE_URL, { searchPath: schema });
  const app = createApp({ db, clock: () => new Date(), config });

  const ids = {
    company: companyId ?? randomUUID(),
    otherCompany: randomUUID(),
    ...Object.fromEntries(PERSONAS.map((p) => [p, randomUUID()])),
  } as Fixture["ids"];
  const sessionIds = Object.fromEntries(
    PERSONAS.map((p) => [p, randomUUID()]),
  ) as Record<Persona, Id>;

  const api = (persona?: Persona): SuperTest<Test> => {
    const agent = request.agent(app);
    if (!persona) return agent as unknown as SuperTest<Test>;
    const headers: Record<string, string> = {
      // Bearer test-session per roadmap; auth lands in task 0.4.
      Authorization: `Bearer test-session-${persona}`,
      Origin: config.appOrigin,
    };
    for (const method of AGENT_METHODS) {
      const original = agent[method].bind(agent);
      (agent as unknown as Record<string, unknown>)[method] = (
        ...args: unknown[]
      ): Test => {
        const t = original(...(args as [string]));
        for (const [k, v] of Object.entries(headers)) t.set(k, v);
        return t;
      };
    }
    return agent as unknown as SuperTest<Test>;
  };

  return {
    db,
    maintenanceDb,
    app,
    ids,
    actor(persona: Persona): ActorContext {
      return {
        userId: ids[persona],
        companyId: ids.company,
        sessionId: sessionIds[persona],
        requestId: randomUUID(),
      };
    },
    api,
    async close(): Promise<void> {
      await db.destroy().catch(() => {});
      // Verify the DB name again before the only cleanup we ever do: dropping
      // the schema this fixture created. Never touch public or shared state.
      await assertConnectedToTestDb(maintenanceDb);
      await maintenanceDb.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await maintenanceDb.destroy();
    },
  };
}
