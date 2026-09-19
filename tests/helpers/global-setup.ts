import knex from "knex";
import { bootstrapDbRoles } from "../../scripts/ops/bootstrap-db-roles.js";

const DEFAULT_TEST_MAINTENANCE_DATABASE_URL =
  "postgres://gwp_test:gwp_test@127.0.0.1:54329/gwp_test";
const DEFAULT_TEST_MIGRATOR_DATABASE_URL =
  "postgres://gwp_migrator:gwp_migrator@127.0.0.1:54329/gwp_test";
const DEFAULT_TEST_DATABASE_URL =
  "postgres://gwp_runtime:gwp_runtime@127.0.0.1:54329/gwp_test";

function urlPassword(url: string): string | undefined {
  try {
    const password = new URL(url).password;
    return password === "" ? undefined : decodeURIComponent(password);
  } catch {
    return undefined;
  }
}

// Vitest globalSetup: assert the disposable test database is reachable and the
// least-privilege roles exist before any integration file runs. Deliberately
// uses TEST_MAINTENANCE_DATABASE_URL (superuser) — never DATABASE_URL, so tests
// can never fall back to a real database. Role passwords are derived from the
// TEST_*_DATABASE_URL values so overridden creds stay the single source of
// truth; tests are a non-production context, so setting them here is allowed.
export default async function globalSetup(): Promise<void> {
  const maintenanceUrl =
    process.env.TEST_MAINTENANCE_DATABASE_URL ??
    DEFAULT_TEST_MAINTENANCE_DATABASE_URL;
  const db = knex({
    client: "pg",
    connection: { connectionString: maintenanceUrl },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 5_000,
  });
  try {
    await db.raw("select 1");
  } catch {
    throw new Error(
      `Test database is not reachable at ${maintenanceUrl}.\n` +
        "Start it with: npm run db:test:up",
    );
  } finally {
    await db.destroy().catch(() => {});
  }

  await bootstrapDbRoles({
    adminUrl: maintenanceUrl,
    schema: "public",
    allowPasswords: true,
    passwords: {
      gwp_migrator:
        urlPassword(
          process.env.TEST_MIGRATOR_DATABASE_URL ??
            DEFAULT_TEST_MIGRATOR_DATABASE_URL,
        ) ?? "gwp_migrator",
      gwp_runtime:
        urlPassword(
          process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
        ) ?? "gwp_runtime",
      gwp_maintenance:
        process.env.GWP_MAINTENANCE_PASSWORD ?? "gwp_maintenance",
    },
  });
}
