import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";

/**
 * Migration seam for task 0.2: every migration is a named `up(db)` applied in
 * registration order inside its own transaction and recorded in the
 * `schema_migration` tracking table. The list is intentionally empty in
 * task 0.1 — readiness reports OK while zero migration files exist.
 *
 * `migrate()` runs against whichever schema the connection's search_path
 * points at, so the test fixture gets the same runner as production.
 */
export interface Migration {
  name: string;
  up(db: Knex): Promise<void>;
}

// Task 0.2 imports ./migrations/0001-foundation.ts here.
export const MIGRATIONS: readonly Migration[] = [];

const TRACKING_TABLE = "schema_migration";

async function ensureTrackingTable(db: Knex): Promise<void> {
  if (!(await db.schema.hasTable(TRACKING_TABLE))) {
    await db.schema.createTable(TRACKING_TABLE, (t) => {
      t.string("name").primary();
      t.timestamp("applied_at", { useTz: true }).notNullable().defaultTo(db.fn.now());
    });
  }
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

export async function migrate(db: Knex): Promise<void> {
  const { pending } = await migrationStatus(db);
  if (pending.length === 0) return;
  await ensureTrackingTable(db);
  for (const name of pending) {
    const migration = MIGRATIONS.find((m) => m.name === name);
    if (!migration) continue;
    await db.transaction(async (tx) => {
      await migration.up(tx);
      await tx(TRACKING_TABLE).insert({ name });
    });
  }
}

// `npm run db:migrate` entrypoint. The operator-facing runner (env loading,
// advisory lock, CLI flags) is task 0.2 scope — fail honestly until then.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  console.error("db:migrate CLI runner is not implemented until task 0.2");
  process.exit(1);
}
