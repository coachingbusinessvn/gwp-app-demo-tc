import knex from "knex";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://gwp_test:gwp_test@127.0.0.1:54329/gwp_test";

// Vitest globalSetup: assert the disposable test database is reachable before
// any integration file runs. Deliberately uses TEST_DATABASE_URL only — never
// DATABASE_URL, so tests can never fall back to a real database.
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const db = knex({
    client: "pg",
    connection: { connectionString: url },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 5_000,
  });
  try {
    await db.raw("select 1");
  } catch {
    throw new Error(
      `Test database is not reachable at ${url}.\n` +
        "Start it with: npm run db:test:up",
    );
  } finally {
    await db.destroy().catch(() => {});
  }
}
