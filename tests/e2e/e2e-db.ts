import path from "node:path";
import { fileURLToPath } from "node:url";
import knex from "knex";
import { bootstrapDbRoles } from "../../scripts/ops/bootstrap-db-roles.js";
import { createDb } from "../../server/src/db/connection.js";
import { migrate } from "../../server/src/db/migrate.js";
import {
  TEST_DATABASE_URL,
  TEST_MAINTENANCE_DATABASE_URL,
  TEST_MIGRATOR_DATABASE_URL,
} from "../helpers/fixture.js";
import { seedCompanyWithPersonas } from "../helpers/seed-personas.js";

/**
 * Dedicated e2e database provisioning (task 0.5): a second database
 * `gwp_e2e` inside the same disposable test Postgres container that vitest
 * uses (compose.test.yaml, port 54329). Browser tests never share schema or
 * data with the per-file `test_*` schemas integration fixtures create inside
 * `gwp_test`, and never touch a real DATABASE_URL.
 *
 * Playwright launches config.webServer BEFORE globalSetup, so provisioning
 * runs inside the server wrapper (tests/e2e/serve.ts) — ordering is
 * guaranteed there. Steps: drop/recreate gwp_e2e → bootstrap least-privilege
 * roles → real migrate() on the migrator credential → seed company + the
 * five personas via the shared SQL helper (tests/helpers/seed-personas.ts).
 */

export const E2E_DB_NAME = "gwp_e2e";

/** Rewrite the database name in a postgres URL, keeping credentials/host. */
function withDb(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export const E2E_URLS = {
  runtime: withDb(TEST_DATABASE_URL, E2E_DB_NAME),
  migrator: withDb(TEST_MIGRATOR_DATABASE_URL, E2E_DB_NAME),
  maintenance: withDb(TEST_MAINTENANCE_DATABASE_URL, E2E_DB_NAME),
} as const;

export const E2E_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function urlPassword(url: string): string | undefined {
  const password = new URL(url).password;
  return password === "" ? undefined : decodeURIComponent(password);
}

async function recreateE2eDatabase(): Promise<void> {
  // The container superuser connects to its home DB (gwp_test) to run
  // CREATE/DROP DATABASE — you cannot drop the DB you are connected to.
  const admin = knex({
    client: "pg",
    connection: { connectionString: TEST_MAINTENANCE_DATABASE_URL },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 5_000,
  });
  try {
    await admin.raw("select 1");
    await admin.raw(`DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)`);
    await admin.raw(`CREATE DATABASE "${E2E_DB_NAME}"`);
  } catch (err) {
    throw new Error(
      `e2e setup: cannot provision database "${E2E_DB_NAME}" via ${TEST_MAINTENANCE_DATABASE_URL}.\n` +
        "Start the test container with: npm run db:test:up\n" +
        `Cause: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    await admin.destroy().catch(() => {});
  }
}

export async function provisionE2eDatabase(): Promise<void> {
  await recreateE2eDatabase();

  // Least-privilege roles on the fresh DB — same bootstrap as vitest.
  await bootstrapDbRoles({
    adminUrl: E2E_URLS.maintenance,
    schema: "public",
    allowPasswords: true,
    passwords: {
      gwp_migrator: urlPassword(TEST_MIGRATOR_DATABASE_URL) ?? "gwp_migrator",
      gwp_runtime: urlPassword(TEST_DATABASE_URL) ?? "gwp_runtime",
      gwp_maintenance:
        process.env.GWP_MAINTENANCE_PASSWORD ?? "gwp_maintenance",
    },
  });

  // Real migrations + persona seed on the migrator credential.
  const migratorDb = createDb(E2E_URLS.migrator);
  try {
    await migrate(migratorDb, { mode: "demo" });
    await seedCompanyWithPersonas(migratorDb, "GWP E2E Company");
  } finally {
    await migratorDb.destroy().catch(() => {});
  }
}
