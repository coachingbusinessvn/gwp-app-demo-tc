import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import knex, { type Knex } from "knex";
import { MIGRATIONS } from "../../server/src/db/migrate.js";
import {
  composeExecArgv,
  envWithPassword,
  parsePgUrl,
  resolvePgRunner,
  runTool,
  type PgRunner,
  type PgTarget,
} from "./pg-runner.js";

/**
 * `npm run ops:restore-test -- --backup <file>` (task 0.6, spec §9):
 * restore drill — recreates the throwaway database `gwp_restore_test`,
 * runs `pg_restore --exit-on-error` into it, then verifies a smoke query.
 *
 * SAFETY (mirrors tests/helpers/disposable-db.ts's double-proof style):
 *   - the database this script drops/creates is a compile-time constant —
 *     RESTORE_DB = "gwp_restore_test". No flag can change it, so the script
 *     can never overwrite gwp_test or any real database;
 *   - the --target maintenance URL must point at a disposable-local host
 *     (127.0.0.1/localhost/::1) UNLESS --i-understand is passed explicitly;
 *   - the live connection re-proves identity via `select current_database()`
 *     before any destructive statement runs.
 *
 * Tool resolution (pg-runner.ts): local psql/pg_restore on PATH first —
 * inside the app container that always holds — else `docker compose exec`
 * into the db service (dropdb/createdb/pg_restore/psql run in-container and
 * the dump file is pushed in with `docker compose cp`). The URL/password is
 * never logged or expanded into argv.
 */

export const RESTORE_DB = "gwp_restore_test";

/** Hosts that are always disposable-local — exported for the drill harness. */
export const DISPOSABLE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const USAGE = `usage: npm run ops:restore-test -- --backup <file.dump> [options]

  --backup <path>        pg_dump -Fc archive to restore (required)
  --target <url>         Maintenance/superuser URL on the server that will
                         host the throwaway database. Defaults to
                         RESTORE_TEST_DATABASE_URL, then the disposable
                         test container (127.0.0.1:54329/gwp_test).
  --i-understand         Required when --target is not a disposable-local
                         host — confirms you know which server you're on.
  --compose-file <file>  Compose file for the fallback runner
                         (default: $GWP_OPS_COMPOSE_FILE or compose.yaml)
  --db-service <name>    Compose service running Postgres
                         (default: $GWP_OPS_DB_SERVICE or db)

The restored database is ALWAYS named ${RESTORE_DB} — it is dropped and
recreated on every run. This is a restore DRILL, never a production
restore path.
`;

interface RestoreArgs {
  backup: string;
  target: string;
  iUnderstand: boolean;
  composeFile?: string;
  dbService?: string;
}

function parseArgs(argv: string[]): RestoreArgs {
  const out: Partial<RestoreArgs> = { iUnderstand: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--backup":
        out.backup = next();
        break;
      case "--target":
        out.target = next();
        break;
      case "--i-understand":
        out.iUnderstand = true;
        break;
      case "--compose-file":
        out.composeFile = next();
        break;
      case "--db-service":
        out.dbService = next();
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.backup) throw new Error("--backup is required");
  out.target ??=
    process.env.RESTORE_TEST_DATABASE_URL ??
    "postgres://gwp_test:gwp_test@127.0.0.1:54329/gwp_test";
  return out as RestoreArgs;
}

/** Guard: refuse non-disposable targets unless explicitly overridden. */
function assertDisposableTarget(target: PgTarget, iUnderstand: boolean): void {
  if (DISPOSABLE_HOSTS.has(target.host)) return;
  if (iUnderstand) {
    console.error(
      `warning: --i-understand accepted for non-local target host "${target.host}" — still only ${RESTORE_DB} will be dropped/recreated`,
    );
    return;
  }
  throw new Error(
    `refusing to run: --target host "${target.host}" is not a disposable ` +
      `test target (127.0.0.1/localhost/::1). The only database this script ` +
      `ever drops is "${RESTORE_DB}", but the server must still be a ` +
      `test/disposable one. Pass --i-understand to confirm an intentional ` +
      `non-local target.`,
  );
}

// --- shared restore core (used by the CLI and the recovery drill) ---

export interface RestoreInfo {
  companies: number;
  /** schema_migration names on the restored copy — schema-version check. */
  migrations: string[];
  /** APP_KEY versions required by restored BYOK envelopes (never material). */
  envelopeKeyVersions: string[];
  /** Cluster roles a pg_dump never carries — must exist before app use. */
  rolesMissing: string[];
  /** Applied migrations this build does not know → restored DB is NEWER. */
  unknownMigrations: string[];
}

const EXPECTED_ROLES = ["gwp_runtime", "gwp_migrator", "gwp_maintenance"];

function restoredUrl(target: PgTarget): string {
  const u = new URL(target.url);
  u.pathname = `/${RESTORE_DB}`;
  return u.toString();
}

async function postRestoreChecks(target: PgTarget): Promise<RestoreInfo> {
  const db = knex({
    client: "pg",
    connection: { connectionString: restoredUrl(target) },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10_000,
  });
  try {
    // The dump preserves its source schema name — `public` in production,
    // the fixture's test_* schema in drills. Discover it via the company
    // table rather than assuming the search_path default.
    const found = await db.raw(
      "select table_schema from information_schema.tables " +
        "where table_name = 'company' limit 1",
    );
    const schema = (found.rows[0]?.table_schema as string | undefined) ?? null;
    if (!schema) {
      throw new Error(
        "restored database has no `company` table — the dump did not " +
          "contain a GWP schema (or pg_restore dropped it)",
      );
    }
    const { rows } = await db.raw(
      `select (select count(*) from "${schema}".company) as companies, ` +
        `(select coalesce(array_agg(name order by name), '{}') from "${schema}".schema_migration) as migrations, ` +
        `(select coalesce(array_agg(distinct value::jsonb -> 'keyEnvelope' ->> 'keyVersion') ` +
        `         filter (where jsonb_exists(value::jsonb, 'keyEnvelope')), '{}') ` +
        `         from "${schema}".setting) as envelope_versions`,
    );
    const migrations = (rows[0].migrations as string[]) ?? [];
    const known = new Set(MIGRATIONS.map((m) => m.name));
    const roleRows = await db.raw(
      "select rolname from pg_roles where rolname = any(?)",
      [EXPECTED_ROLES],
    );
    const present = new Set(
      (roleRows.rows as { rolname: string }[]).map((r) => r.rolname),
    );
    return {
      companies: Number(rows[0].companies),
      migrations,
      envelopeKeyVersions: (
        (rows[0].envelope_versions as (string | null)[]) ?? []
      ).filter((v): v is string => typeof v === "string"),
      rolesMissing: EXPECTED_ROLES.filter((r) => !present.has(r)),
      unknownMigrations: migrations.filter((n) => !known.has(n)),
    };
  } finally {
    await db.destroy().catch(() => {});
  }
}

// --- local runner: psql/pg_restore on PATH, knex for DDL + verification ---

async function runLocal(target: PgTarget, backup: string): Promise<RestoreInfo> {
  const admin = knex({
    client: "pg",
    connection: { connectionString: target.url },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10_000,
  });
  try {
    // Second proof: the connection we actually hold must be the URL's db.
    const { rows } = await admin.raw("select current_database() as name");
    if (rows[0]?.name !== target.dbName) {
      throw new Error(
        `refusing to run: connected to "${rows[0]?.name}", expected "${target.dbName}"`,
      );
    }
    await admin.raw(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
    await admin.raw(`CREATE DATABASE ${RESTORE_DB}`);
  } finally {
    await admin.destroy().catch(() => {});
  }

  const res = runTool(
    [
      "pg_restore",
      "--exit-on-error",
      "--host",
      target.host,
      "--port",
      target.port,
      "--username",
      target.user,
      "--dbname",
      RESTORE_DB,
      backup,
    ],
    { env: envWithPassword(target) },
  );
  if (res.status !== 0) {
    throw new Error(`pg_restore failed with exit code ${res.status}`);
  }
  return postRestoreChecks(target);
}

// --- compose runner: tools inside the db service container ---

function composeExec(
  runner: Extract<PgRunner, { kind: "compose" }>,
  target: PgTarget,
  argv: string[],
): { status: number; stdout: string } {
  return runTool(["docker", ...composeExecArgv(runner, argv)], {
    env: envWithPassword(target),
  });
}

async function runCompose(
  runner: Extract<PgRunner, { kind: "compose" }>,
  target: PgTarget,
  backup: string,
): Promise<RestoreInfo> {
  // The --target URL's user is the identity for drop/create/restore —
  // its password travels via PGPASSWORD through envWithPassword(target).
  const base = ["--host", "127.0.0.1", "--username", target.user];

  // Second proof inside the container: the db we land on must be the one
  // the --target URL names.
  const check = composeExec(runner, target, [
    "psql",
    ...base,
    "--dbname",
    target.dbName,
    "-tAc",
    "select current_database()",
  ]);
  if (check.status !== 0 || check.stdout.trim() !== target.dbName) {
    throw new Error(
      `refusing to run: compose service "${runner.service}" answered ` +
        `current_database()="${check.stdout.trim()}", expected "${target.dbName}"`,
    );
  }

  const drop = composeExec(runner, target, [
    "dropdb",
    ...base,
    "--if-exists",
    "--force",
    RESTORE_DB,
  ]);
  if (drop.status !== 0) throw new Error("dropdb failed");

  const create = composeExec(runner, target, [
    "createdb",
    ...base,
    RESTORE_DB,
  ]);
  if (create.status !== 0) throw new Error("createdb failed");

  // The dump must reach the container: `docker compose cp` it in, restore
  // from the in-container path, then clean it up (best effort).
  const containerPath = `/tmp/gwp-restore-${process.pid}.dump`;
  const cp = runTool([
    "docker",
    "compose",
    "-f",
    runner.composeFile,
    "cp",
    backup,
    `${runner.service}:${containerPath}`,
  ]);
  if (cp.status !== 0) {
    throw new Error("docker compose cp failed — could not copy dump in");
  }
  try {
    const restore = composeExec(runner, target, [
      "pg_restore",
      "--exit-on-error",
      ...base,
      "--dbname",
      RESTORE_DB,
      containerPath,
    ]);
    if (restore.status !== 0) {
      throw new Error(`pg_restore failed with exit code ${restore.status}`);
    }
  } finally {
    composeExec(runner, target, ["rm", "-f", containerPath]);
  }
  return postRestoreChecks(target);
}

/**
 * Recreate RESTORE_DB from a pg_dump -Fc archive and run the post-restore
 * checks. Exported for the recovery drill — the operator-facing wrapper is
 * main() below, which adds the disposable-target confirmation and prints
 * the warnings a human must see.
 */
export async function restoreArchive(
  target: PgTarget,
  backup: string,
  runner?: PgRunner,
): Promise<RestoreInfo> {
  const r =
    runner ??
    resolvePgRunner({
      tools: ["psql", "pg_restore"],
      composeFile: process.env.GWP_OPS_COMPOSE_FILE,
      dbService: process.env.GWP_OPS_DB_SERVICE,
    });
  return r.kind === "local"
    ? runLocal(target, backup)
    : runCompose(r, target, backup);
}

/**
 * Backup age basis for the measured RPO: the sidecar manifest's createdAt
 * (ops:backup writes it), else the dump file's mtime when the manifest is
 * missing or unparsable. Exported — upgrade-check uses the same rule.
 */
export function backupCreatedAtMs(backup: string): number {
  try {
    const manifest = JSON.parse(
      readFileSync(`${backup}.manifest.json`, "utf8"),
    ) as { createdAt?: string };
    const t = Date.parse(manifest.createdAt ?? "");
    if (Number.isFinite(t)) return t;
  } catch {
    /* no/invalid manifest — fall back to the dump file's mtime */
  }
  return statSync(backup).mtimeMs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Guard FIRST — validate the target before touching anything else.
  const target = parsePgUrl(args.target, "--target");
  assertDisposableTarget(target, args.iUnderstand);

  const backup = path.resolve(args.backup);
  if (!existsSync(backup) || statSync(backup).size === 0) {
    throw new Error(`backup file missing or empty: ${backup}`);
  }
  const backupBytes = statSync(backup).size;
  const backupCreatedAt = backupCreatedAtMs(backup);

  const runner = resolvePgRunner({
    tools: ["psql", "pg_restore"],
    composeFile: args.composeFile,
    dbService: args.dbService,
  });

  console.log(
    `restoring ${path.basename(backup)} into "${RESTORE_DB}" via ` +
      (runner.kind === "local"
        ? `local pg_restore on ${target.host}`
        : `docker compose exec ${runner.service}`),
  );

  const restoreStartedAt = Date.now();
  const info = await restoreArchive(target, backup, runner);
  const rtoMs = Date.now() - restoreStartedAt;
  const rpoAgeMs = Math.max(0, restoreStartedAt - backupCreatedAt);
  console.log(
    `smoke query on ${RESTORE_DB}: companies=${info.companies} ` +
      `migrations=${info.migrations.length}`,
  );
  if (info.rolesMissing.length > 0) {
    console.error(
      `warning: cluster roles missing on this server: ${info.rolesMissing.join(", ")} ` +
        "— a pg_dump never carries roles; run scripts/ops/bootstrap-db-roles " +
        "before the app can use this database",
    );
  }
  if (info.unknownMigrations.length > 0) {
    console.error(
      `warning: restored schema has migrations this build does not know: ` +
        `${info.unknownMigrations.join(", ")} — the backup is NEWER than this ` +
        "code; do not run the app/migrator against it (no blind downgrade)",
    );
  }
  if (info.envelopeKeyVersions.length > 0) {
    console.error(
      `note: restored BYOK envelopes need APP_KEY version(s) ` +
        `${info.envelopeKeyVersions.join(", ")} in the ring — without them ` +
        "the stored AI key cannot be decrypted",
    );
  }
  console.log(
    `restore-test complete: "${RESTORE_DB}" recreated and verified`,
  );
  // Measured, not assumed (spec §9): RTO = restore+verification wall time;
  // RPO = backup age at restore start (manifest createdAt, else mtime).
  // Last line stays machine-readable so an operator can paste it into the
  // drill record — `restore-test metrics: {"rtoMs":…,"rpoAgeMs":…,…}`.
  console.log(
    `restore-test metrics: ${JSON.stringify({ rtoMs, rpoAgeMs, backupBytes })}`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      "ops:restore-test failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
