import { existsSync, statSync } from "node:fs";
import path from "node:path";
import knex from "knex";
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

const RESTORE_DB = "gwp_restore_test";

const DISPOSABLE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const USAGE = `usage: npm run ops:restore-test -- --backup <file.dump> [options]

  --backup <path>        pg_dump -Fc archive to restore (required)
  --target <url>         Maintenance/superuser URL on the server that will
                         host the throwaway database. Defaults to
                         RESTORE_TEST_DATABASE_URL, then the disposable
                         test container (127.0.0.1:54329/gwp_test).
  --admin-user <name>    DB superuser for drop/create/restore in compose
                         mode (default: the --target URL's username)
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
  adminUser?: string;
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
      case "--admin-user":
        out.adminUser = next();
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

// --- local runner: psql/pg_restore on PATH, knex for DDL + verification ---

async function runLocal(target: PgTarget, backup: string): Promise<void> {
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

  const restored = knex({
    client: "pg",
    connection: {
      connectionString: target.url.replace(
        `/${target.dbName}`,
        `/${RESTORE_DB}`,
      ),
    },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10_000,
  });
  try {
    const { rows } = await restored.raw(
      "select (select count(*) from company) as companies, " +
        "(select count(*) from schema_migration) as migrations",
    );
    console.log(
      `smoke query on ${RESTORE_DB}: companies=${rows[0].companies} schema_migration=${rows[0].migrations}`,
    );
  } finally {
    await restored.destroy().catch(() => {});
  }
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

function runCompose(
  runner: Extract<PgRunner, { kind: "compose" }>,
  target: PgTarget,
  backup: string,
): void {
  const adminUser = target.user;
  const base = ["--host", "127.0.0.1", "--username", adminUser];

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

  const smoke = composeExec(runner, target, [
    "psql",
    ...base,
    "--dbname",
    RESTORE_DB,
    "-tAc",
    "select (select count(*) from company) as companies, " +
      "(select count(*) from schema_migration) as migrations",
  ]);
  if (smoke.status !== 0) {
    throw new Error("smoke query failed on the restored database");
  }
  console.log(
    `smoke query on ${RESTORE_DB}: counts(company|schema_migration)=${smoke.stdout.trim()}`,
  );
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

  if (runner.kind === "local") {
    await runLocal(target, backup);
  } else {
    runCompose(runner, target, backup);
  }
  console.log(
    `restore-test complete: "${RESTORE_DB}" recreated and verified`,
  );
}

main().catch((err: unknown) => {
  console.error(
    "ops:restore-test failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
