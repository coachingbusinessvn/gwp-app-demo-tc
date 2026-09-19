import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";
import type { DemoMode } from "../config.js";
import { createDb } from "./connection.js";
import { foundationMigration } from "./migrations/0001-foundation.js";

/**
 * Migration runner: every migration is a named `up(db)` applied in
 * registration order inside its own transaction and recorded in the
 * `schema_migration` tracking table.
 *
 * `migrate()` runs against whichever schema the connection's search_path
 * points at, so the test fixture gets the same runner as production.
 * Concurrent migrators serialize on a per-migration advisory lock
 * (pg_advisory_xact_lock) with an in-transaction re-check, so a second runner
 * that was waiting sees the migration already applied and skips it.
 */
export interface Migration {
  name: string;
  up(db: Knex): Promise<void>;
}

export const MIGRATIONS: readonly Migration[] = [foundationMigration];

const TRACKING_TABLE = "schema_migration";

// Arbitrary fixed key for the migration advisory lock (xact-scoped).
const MIGRATION_LOCK_KEY = 7282031;

const RUNTIME_ROLE = "gwp_runtime";

async function ensureTrackingTable(db: Knex): Promise<void> {
  // IF NOT EXISTS keeps two racing migrators from failing on duplicate create.
  await db.raw(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

export async function migrationStatus(db: Knex): Promise<MigrationStatus> {
  const known = MIGRATIONS.map((m) => m.name);
  if (known.length === 0) return { applied: [], pending: [] };
  const applied = (await db.schema.hasTable(TRACKING_TABLE))
    ? (await db(TRACKING_TABLE).select("name")).map(
        (row: { name: string }) => row.name,
      )
    : [];
  return { applied, pending: known.filter((n) => !applied.includes(n)) };
}

function resolveDemoMode(raw: string | undefined): DemoMode {
  if (raw === undefined || raw === "") return "production";
  if (raw === "demo" || raw === "production") return raw;
  throw new Error(`DEMO_MODE must be "demo" or "production", got "${raw}"`);
}

export interface MigrateOptions {
  /**
   * Mode written into deployment_state when its singleton row is seeded.
   * Defaults to process.env.DEMO_MODE (default "production"). The fixture
   * passes its test config so each schema's deployment mode is test-settable;
   * later tasks may UPDATE the row directly for per-test overrides.
   */
  mode?: DemoMode;
}

export async function migrate(
  db: Knex,
  options?: MigrateOptions,
): Promise<void> {
  const { pending } = await migrationStatus(db);
  if (pending.length > 0) {
    await ensureTrackingTable(db);
    for (const name of pending) {
      const migration = MIGRATIONS.find((m) => m.name === name);
      if (!migration) continue;
      await db.transaction(async (tx) => {
        await tx.raw("SELECT pg_advisory_xact_lock(?)", [MIGRATION_LOCK_KEY]);
        const already = await tx(TRACKING_TABLE).where({ name }).first();
        if (already) return;
        await migration.up(tx);
        await tx(TRACKING_TABLE).insert({ name });
      });
    }
  }

  // The deployment_state singleton is seeded by the runner (not inside the
  // migration) so mode comes from config/env; INSERT ... ON CONFLICT keeps a
  // re-run or a parallel migrator idempotent.
  if (await db.schema.hasTable("deployment_state")) {
    const mode = options?.mode ?? resolveDemoMode(process.env.DEMO_MODE);
    await db("deployment_state")
      .insert({ singleton_id: 1, mode })
      .onConflict("singleton_id")
      .ignore();
  }

  await enforceRuntimeRestrictions(db);
}

/**
 * Deterministic, order-independent protection for append-only audit and
 * read-only migration tracking. ALTER DEFAULT PRIVILEGES (bootstrap-db-roles)
 * grants the runtime role full DML on every table the migrator creates — so
 * when bootstrap ran before the tables existed, audit_event/schema_migration
 * are born writable by gwp_runtime. This connection runs as gwp_migrator, the
 * table owner, so these revokes always succeed regardless of provisioning
 * order; the bootstrap script keeps its own guarded revokes as defense in
 * depth for the opposite order. gwp_runtime may not exist yet when migrate
 * runs before bootstrap — skip silently in that case.
 *
 * deployment_state gets column-level UPDATE instead of a blanket revoke:
 * setup and the demo seed legitimately advance setup_completed_at /
 * seed_version through the runtime credential, but `mode` is an immutable
 * property of the database (spec §8) and must never be runtime-writable.
 */
async function enforceRuntimeRestrictions(db: Knex): Promise<void> {
  const role = await db.raw("SELECT 1 FROM pg_roles WHERE rolname = ?", [
    RUNTIME_ROLE,
  ]);
  if (role.rows.length === 0) return;

  const audit = await db.raw("SELECT to_regclass(?) AS c", ["audit_event"]);
  if (audit.rows[0].c !== null) {
    await db.raw(
      `REVOKE UPDATE, DELETE ON TABLE "audit_event" FROM "${RUNTIME_ROLE}"`,
    );
  }
  const tracking = await db.raw("SELECT to_regclass(?) AS c", [TRACKING_TABLE]);
  if (tracking.rows[0].c !== null) {
    await db.raw(
      `REVOKE INSERT, UPDATE, DELETE ON TABLE "${TRACKING_TABLE}" FROM "${RUNTIME_ROLE}"`,
    );
  }
  const deployment = await db.raw("SELECT to_regclass(?) AS c", [
    "deployment_state",
  ]);
  if (deployment.rows[0].c !== null) {
    await db.raw(
      `REVOKE UPDATE ON TABLE "deployment_state" FROM "${RUNTIME_ROLE}"`,
    );
    await db.raw(
      `GRANT UPDATE (setup_completed_at, seed_version) ON TABLE "deployment_state" TO "${RUNTIME_ROLE}"`,
    );
  }
}

/**
 * Connection URL for `npm run db:migrate`: the dedicated migrator credential.
 * Production must supply MIGRATOR_DATABASE_URL — the API's runtime credential
 * has no DDL rights and must never gain them; dev/test may fall back to
 * DATABASE_URL.
 */
export function resolveMigratorUrl(env: NodeJS.ProcessEnv): string {
  if (env.NODE_ENV === "production" && !env.MIGRATOR_DATABASE_URL)
    throw new Error(
      "NODE_ENV=production requires MIGRATOR_DATABASE_URL — migrations run under a separate credential with DDL rights",
    );
  const url = env.MIGRATOR_DATABASE_URL ?? env.DATABASE_URL;
  if (!url)
    throw new Error(
      "db:migrate requires MIGRATOR_DATABASE_URL or DATABASE_URL",
    );
  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, "");
  } catch {
    throw new Error("db:migrate connection URL is not a valid URL");
  }
  if (scheme !== "postgres" && scheme !== "postgresql")
    throw new Error(
      `db:migrate connection URL must be a postgres:// URL, got scheme "${scheme}"`,
    );
  return url;
}

// `npm run db:migrate` entrypoint.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const url = resolveMigratorUrl(process.env);
    const db = createDb(url);
    try {
      await migrate(db);
      const status = await migrationStatus(db);
      console.log(
        `db:migrate complete — applied: ${status.applied.join(", ") || "(none)"}; pending: ${status.pending.length}`,
      );
    } finally {
      await db.destroy().catch(() => {});
    }
  } catch (err) {
    console.error(
      "db:migrate failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}
