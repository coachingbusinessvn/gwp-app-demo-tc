import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Knex } from "knex";
import request, { type SuperTest, type Test } from "supertest";
import { createApp } from "../../server/src/app.js";
import { loadConfig, type DemoMode } from "../../server/src/config.js";
import { createDb } from "../../server/src/db/connection.js";
import { migrate } from "../../server/src/db/migrate.js";
import type {
  ActorContext,
  Id,
} from "../../server/src/shared/contracts.js";
import {
  assertConnectedToDisposableDb,
  assertDisposableDbUrl,
} from "./disposable-db.js";
import {
  FIXTURE_PASSWORD,
  PERSONAS,
  generatePersonaIds,
  personaEmail,
  seedCompanyWithPersonas,
  type Persona,
} from "./seed-personas.js";

export {
  FIXTURE_PASSWORD,
  PERSONAS,
  personaEmail,
  type Persona,
} from "./seed-personas.js";

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
  // Trust loopback X-Forwarded-For so each fixture can present a distinct
  // client IP — otherwise every parallel fixture shares one per-IP rate-limit
  // bucket and seeded logins flake under load (e2e does the same).
  TRUST_PROXY: "loopback",
};

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/i;

function urlUser(url: string): string {
  const user = decodeURIComponent(new URL(url).username);
  if (!ROLE_NAME.test(user))
    throw new Error(`fixture: unsafe DB role name "${user}" in ${url}`);
  return user;
}

function assertTestDatabaseUrl(url: string): void {
  assertDisposableDbUrl(url, {
    envVar: "TEST_*_DATABASE_URL",
    dbName: "gwp_test",
  });
}

async function assertConnectedToTestDb(db: Knex): Promise<void> {
  await assertConnectedToDisposableDb(db, "gwp_test");
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
 * credential. seeded:true inserts the single company row plus the five
 * personas (active, FIXTURE_PASSWORD, ids.* are the real user UUIDs) via
 * test-only SQL, then performs a REAL POST /api/v1/auth/login per persona —
 * api(persona) sends the cached access token as Bearer, never a fabricated
 * token (task 0.4). otherCompany stays a nonexistent UUID for forged-input
 * tests.
 *
 * migrated:false creates the schema and runtime connection but skips
 * migrations/grants — for readiness/probe tests that need a pending state.
 *
 * mode overrides DEMO_MODE for this fixture only: config.mode (loadConfig)
 * and the deployment_state row are both set, via a post-migration UPDATE on
 * the maintenance connection (test schemas only — production mode is fixed
 * at migration time and never flipped by the app).
 */
export async function fixture(options?: {
  seeded?: boolean;
  migrated?: boolean;
  mode?: DemoMode;
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
  const config = loadConfig({
    ...testEnv,
    DEMO_MODE: options?.mode ?? testEnv.DEMO_MODE,
  });
  const runtimeRole = urlUser(TEST_DATABASE_URL);
  const migratorRole = urlUser(TEST_MIGRATOR_DATABASE_URL);
  const personaIds = generatePersonaIds();
  // Each fixture presents as its own client IP so parallel fixtures get
  // independent rate-limit buckets (TRUST_PROXY=loopback in testEnv).
  const fixtureIp = `10.${(Math.random() * 254 + 1) | 0}.${
    (Math.random() * 254 + 1) | 0
  }.${(Math.random() * 254 + 1) | 0}`;

  // Small pools per fixture: 3 connections each × parallel workers must stay
  // far below the disposable container's max_connections.
  const maintenanceDb = createDb(TEST_MAINTENANCE_DATABASE_URL, {
    poolMax: 2,
  });
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
        poolMax: 2,
      });
      try {
        await migrate(migratorDb, { mode: config.mode });
        if (options?.seeded) {
          const seeded = await seedCompanyWithPersonas(
            migratorDb,
            "GWP Test Company",
            personaIds,
          );
          companyId = seeded.companyId;
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
      // canvas_version is insert-once/read-only for runtime — published
      // snapshots are immutable (spec §5.2), same discipline as audit_event.
      await maintenanceDb.raw(
        `REVOKE UPDATE, DELETE ON TABLE "${schema}".canvas_version FROM "${runtimeRole}"`,
      );
      // write_receipt: INSERT/DELETE allowed (stale-slot reclaim); UPDATE
      // revoked — it could rewrite request_hash/result_id and forge replays.
      await maintenanceDb.raw(
        `REVOKE UPDATE ON TABLE "${schema}".write_receipt FROM "${runtimeRole}"`,
      );
      await maintenanceDb.raw(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".schema_migration FROM "${runtimeRole}"`,
      );
      // deployment_state: runtime may advance setup_completed_at /
      // seed_version (setup service, demo seed) but never mode — DEMO_MODE
      // is an immutable property of the DB (spec §8).
      await maintenanceDb.raw(
        `REVOKE UPDATE ON TABLE "${schema}".deployment_state FROM "${runtimeRole}"`,
      );
      await maintenanceDb.raw(
        `GRANT UPDATE (setup_completed_at, seed_version) ON TABLE "${schema}".deployment_state TO "${runtimeRole}"`,
      );
      await maintenanceDb.raw(
        `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "gwp_maintenance"`,
      );
      await maintenanceDb.raw(
        `GRANT DELETE ON TABLE "${schema}".audit_event TO "gwp_maintenance"`,
      );

      // Per-fixture deployment mode override (test schemas only). migrate()
      // already seeds the singleton with config.mode; this UPDATE via the
      // maintenance connection is the explicit override path so tests can
      // pin the recorded mode independently of process env.
      if (options?.mode) {
        await maintenanceDb.raw(
          `UPDATE "${schema}".deployment_state SET mode = ? WHERE singleton_id = 1`,
          [options.mode],
        );
      }
    }
  } catch (err) {
    await maintenanceDb
      .raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => {});
    await maintenanceDb.destroy().catch(() => {});
    throw err;
  }

  const db = createDb(TEST_DATABASE_URL, { searchPath: schema, poolMax: 5 });
  const app = createApp({ db, clock: () => new Date(), config });

  // Real login per persona through the mounted routes — the cached access
  // token is indistinguishable from a browser's (spec §8: tests do not fake
  // tokens). On failure, tear down everything this fixture created.
  const personaTokens = {} as Record<Persona, string>;
  if (options?.seeded) {
    try {
      for (const persona of PERSONAS) {
        const res = await request(app)
          .post("/api/v1/auth/login")
          .set("Origin", config.appOrigin)
          .set("X-Forwarded-For", fixtureIp)
          .send({ email: personaEmail(persona), password: FIXTURE_PASSWORD });
        if (res.status !== 200) {
          throw new Error(
            `fixture: persona login for "${persona}" returned ${res.status} — ` +
              "seeded fixtures require the mounted auth routes",
          );
        }
        personaTokens[persona] = (res.body as { accessToken: string })
          .accessToken;
      }
    } catch (err) {
      await db.destroy().catch(() => {});
      await maintenanceDb
        .raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => {});
      await maintenanceDb.destroy().catch(() => {});
      throw err;
    }
  }

  const ids = {
    company: companyId ?? randomUUID(),
    otherCompany: randomUUID(),
    ...personaIds,
  } as Fixture["ids"];
  const sessionIds = Object.fromEntries(
    PERSONAS.map((p) => [p, randomUUID()]),
  ) as Record<Persona, Id>;

  const api = (persona?: Persona): SuperTest<Test> => {
    const agent = request.agent(app);
    const headers: Record<string, string> = {
      Origin: config.appOrigin,
      "X-Forwarded-For": fixtureIp,
    };
    if (persona) {
      const token = personaTokens[persona];
      if (!token) {
        throw new Error(
          `fixture: api(${persona}) requires fixture({ seeded: true }) — ` +
            "personas and their sessions are only created for seeded fixtures",
        );
      }
      // Real cached access token from the persona's login — never a
      // fabricated token (spec §8).
      headers.Authorization = `Bearer ${token}`;
    }
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
