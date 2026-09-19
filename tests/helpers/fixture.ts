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
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
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

function assertTestDatabaseUrl(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName !== "gwp_test") {
    throw new Error(
      `fixture refuses to use database "${dbName}" — TEST_DATABASE_URL must point at gwp_test`,
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
 * file/test), search_path isolation, real migrate() runner. Persona seeds and
 * signed sessions arrive in tasks 0.3–0.4; until then ids are freshly minted
 * UUIDs and api(persona) attaches a placeholder Bearer header.
 */
export async function fixture(options?: { seeded?: boolean }): Promise<Fixture> {
  assertTestDatabaseUrl(TEST_DATABASE_URL);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const config = loadConfig(testEnv);

  // maintenanceDb: same superuser creds as the runtime connection for now;
  // task 0.2 splits migrator/runtime/maintenance credentials. It stays on the
  // default search_path (public) and is used only for create/drop schema.
  const maintenanceDb = createDb(TEST_DATABASE_URL);
  await assertConnectedToTestDb(maintenanceDb);
  await maintenanceDb.raw(`CREATE SCHEMA "${schema}"`);

  const db = createDb(TEST_DATABASE_URL, { searchPath: schema });
  try {
    await migrate(db);
    if (options?.seeded) {
      // Company/persona seeding lands in tasks 0.3–0.4 via SQL test-only
      // fixtures; nothing exists to seed yet (zero migrations).
    }
  } catch (err) {
    await db.destroy().catch(() => {});
    await maintenanceDb
      .raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => {});
    await maintenanceDb.destroy().catch(() => {});
    throw err;
  }

  const app = createApp({ db, clock: () => new Date(), config });

  const ids = {
    company: randomUUID(),
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
