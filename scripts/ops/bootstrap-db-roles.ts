import path from "node:path";
import { pathToFileURL } from "node:url";
import knex from "knex";

/**
 * Operator script — creates the three least-privilege database roles the app
 * uses and grants schema/table privileges. Idempotent: safe to re-run, and
 * SHOULD be re-run after migrations that add tables so the new relations pick
 * up grants (default privileges cover tables gwp_migrator creates, but the
 * audit_event/schema_migration restrictions below are table-specific). Note
 * the ordering hazard this creates: run before db:migrate, the guarded
 * revokes are skipped while default privileges auto-grant runtime write on
 * audit_event/schema_migration at CREATE time — so migrate() itself re-issues
 * those revokes as table owner (see enforceRuntimeRestrictions in
 * server/src/db/migrate.ts). The revokes here are defense in depth for the
 * opposite order.
 *
 *   gwp_migrator    — owns schema objects; runs migrations (DDL + full DML)
 *   gwp_runtime     — the API server's account; DML only, with audit_event
 *                     restricted to INSERT/SELECT (append-only audit),
 *                     schema_migration restricted to SELECT, and
 *                     deployment_state UPDATE limited to the
 *                     setup_completed_at/seed_version columns (mode is
 *                     immutable per DB — spec §8)
 *   gwp_maintenance — backup/retention jobs; SELECT everywhere + DELETE on
 *                     audit_event for retention cleanup
 *
 * Passwords are set ONLY outside production: when NODE_ENV=production the
 * script creates the roles without passwords and never alters them — the
 * operator provisions passwords through the secret store (e.g. a secured
 * ALTER ROLE ... PASSWORD session). In dev/test it sets passwords supplied
 * via env (GWP_MIGRATOR_PASSWORD / GWP_RUNTIME_PASSWORD /
 * GWP_MAINTENANCE_PASSWORD) or the `passwords` option.
 *
 * Env (CLI): BOOTSTRAP_ADMIN_URL (falls back to DATABASE_URL) — an account
 * allowed to CREATE ROLE and grant on the target schema; BOOTSTRAP_SCHEMA
 * (default "public").
 */

export type DbRoleName = "gwp_migrator" | "gwp_runtime" | "gwp_maintenance";

export const DB_ROLE_NAMES: readonly DbRoleName[] = [
  "gwp_migrator",
  "gwp_runtime",
  "gwp_maintenance",
];

export interface BootstrapRolesOptions {
  /** Connection URL of an account that may CREATE ROLE and GRANT on schema. */
  adminUrl: string;
  /** Schema the app tables live in. Default "public". */
  schema?: string;
  /** Passwords per role — applied only when allowPasswords is true. */
  passwords?: Partial<Record<DbRoleName, string>>;
  /**
   * Whether ALTER ROLE ... PASSWORD runs. Default: NODE_ENV !== "production".
   * In production passwords are operator-secret managed; this script never
   * sets them.
   */
  allowPasswords?: boolean;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;

/** Single-quote SQL literal — for statements (ALTER ROLE) that cannot bind parameters. */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function bootstrapDbRoles(
  options: BootstrapRolesOptions,
): Promise<void> {
  const schema = options.schema ?? "public";
  if (!IDENTIFIER.test(schema))
    throw new Error(`bootstrap-db-roles: unsafe schema name "${schema}"`);
  const allowPasswords =
    options.allowPasswords ?? process.env.NODE_ENV !== "production";

  const db = knex({
    client: "pg",
    connection: { connectionString: options.adminUrl },
    pool: { min: 0, max: 2 },
    acquireConnectionTimeout: 10_000,
  });
  try {
    for (const role of DB_ROLE_NAMES) {
      const { rows } = await db.raw("SELECT 1 FROM pg_roles WHERE rolname = ?", [
        role,
      ]);
      if (rows.length === 0) {
        await db.raw(`CREATE ROLE "${role}" LOGIN`);
      }
      const password = options.passwords?.[role];
      if (allowPasswords && password) {
        await db.raw(`ALTER ROLE "${role}" PASSWORD ${sqlLiteral(password)}`);
      }
    }

    // Schema-level privileges (spec §9: runtime least privilege, migrator DDL).
    await db.raw(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "gwp_migrator"`);
    await db.raw(
      `GRANT USAGE ON SCHEMA "${schema}" TO "gwp_runtime", "gwp_maintenance"`,
    );

    // Table privileges for whatever already exists in the schema.
    await db.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "gwp_runtime"`,
    );
    await db.raw(
      `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "gwp_maintenance"`,
    );

    // audit_event stays append-only for runtime; maintenance may DELETE for
    // retention. Guarded by to_regclass so the script works pre-migration.
    const audit = await db.raw("SELECT to_regclass(?) AS c", [
      `${schema}.audit_event`,
    ]);
    if (audit.rows[0].c !== null) {
      await db.raw(
        `REVOKE UPDATE, DELETE ON TABLE "${schema}".audit_event FROM "gwp_runtime"`,
      );
      await db.raw(
        `GRANT DELETE ON TABLE "${schema}".audit_event TO "gwp_maintenance"`,
      );
    }
    // Runtime may read migration tracking (readiness probe) but never write it.
    const tracking = await db.raw("SELECT to_regclass(?) AS c", [
      `${schema}.schema_migration`,
    ]);
    if (tracking.rows[0].c !== null) {
      await db.raw(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".schema_migration FROM "gwp_runtime"`,
      );
    }
    // deployment_state: runtime may advance setup_completed_at /
    // seed_version (setup service, demo seed) but never mode — DEMO_MODE is
    // an immutable property of the database (spec §8).
    const deployment = await db.raw("SELECT to_regclass(?) AS c", [
      `${schema}.deployment_state`,
    ]);
    if (deployment.rows[0].c !== null) {
      await db.raw(
        `REVOKE UPDATE ON TABLE "${schema}".deployment_state FROM "gwp_runtime"`,
      );
      await db.raw(
        `GRANT UPDATE (setup_completed_at, seed_version) ON TABLE "${schema}".deployment_state TO "gwp_runtime"`,
      );
    }

    // Future tables created by the migrator inherit runtime DML + maintenance
    // SELECT automatically (applies to every schema in this database).
    await db.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "gwp_migrator" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "gwp_runtime"`,
    );
    await db.raw(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "gwp_migrator" GRANT SELECT ON TABLES TO "gwp_maintenance"`,
    );
  } finally {
    await db.destroy().catch(() => {});
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    const adminUrl =
      process.env.BOOTSTRAP_ADMIN_URL ?? process.env.DATABASE_URL;
    if (!adminUrl)
      throw new Error(
        "set BOOTSTRAP_ADMIN_URL (or DATABASE_URL) to an account that can CREATE ROLE and grant on the target schema",
      );
    const production = process.env.NODE_ENV === "production";
    if (production)
      console.log(
        "NODE_ENV=production — roles are created without passwords; set them via operator secrets",
      );
    await bootstrapDbRoles({
      adminUrl,
      schema: process.env.BOOTSTRAP_SCHEMA ?? "public",
      allowPasswords: !production,
      passwords: {
        gwp_migrator: process.env.GWP_MIGRATOR_PASSWORD,
        gwp_runtime: process.env.GWP_RUNTIME_PASSWORD,
        gwp_maintenance: process.env.GWP_MAINTENANCE_PASSWORD,
      },
    });
    console.log(
      "db roles ready: gwp_migrator, gwp_runtime, gwp_maintenance",
    );
  } catch (err) {
    console.error(
      "bootstrap-db-roles failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
}
