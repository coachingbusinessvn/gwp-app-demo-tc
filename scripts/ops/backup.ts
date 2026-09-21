import { closeSync, openSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import knex from "knex";
import {
  composeExecArgv,
  envWithPassword,
  parsePgUrl,
  resolvePgRunner,
  runTool,
} from "./pg-runner.js";

/**
 * `npm run ops:backup -- --output <path>` (task 0.6, spec §9): pg_dump
 * custom-format (-Fc) dump of the database.
 *
 * Connection: `--url <postgres-url>` > BACKUP_DATABASE_URL > DATABASE_URL.
 * Use the gwp_maintenance (read-only) credential for routine backups; any
 * credential with SELECT on all tables works — the dump contains no
 * sequences to re-own in Phase 0.
 *
 * Tool resolution (pg-runner.ts): pg_dump on PATH first — inside the app
 * container that always holds — else `docker compose exec` into the db
 * service, streaming the archive to the host file over stdout.
 *
 * The URL/password is NEVER logged or expanded into argv; only the output
 * path and byte size are printed.
 */

const USAGE = `usage: npm run ops:backup -- --output <path.dump> [options]

  --output <path>        Destination file (required)
  --url <postgres-url>   Source DB URL — defaults to BACKUP_DATABASE_URL,
                         then DATABASE_URL
  --compose-file <file>  Compose file for the fallback runner
                         (default: $GWP_OPS_COMPOSE_FILE or compose.yaml)
  --db-service <name>    Compose service running Postgres
                         (default: $GWP_OPS_DB_SERVICE or db)
`;

interface BackupArgs {
  output: string;
  url?: string;
  composeFile?: string;
  dbService?: string;
}

function parseArgs(argv: string[]): BackupArgs {
  const out: Partial<BackupArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--output":
        out.output = next();
        break;
      case "--url":
        out.url = next();
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
  if (!out.output) throw new Error("--output is required");
  return out as BackupArgs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawUrl =
    args.url ?? process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      "no source database URL — pass --url or set BACKUP_DATABASE_URL/DATABASE_URL",
    );
  }
  const target = parsePgUrl(rawUrl, "backup source URL");
  const output = path.resolve(args.output);

  const runner = resolvePgRunner({
    tools: ["pg_dump"],
    composeFile: args.composeFile,
    dbService: args.dbService,
  });

  let status: number;
  if (runner.kind === "local") {
    status = runTool(
      [
        "pg_dump",
        "--format=custom",
        "--file",
        output,
        "--host",
        target.host,
        "--port",
        target.port,
        "--username",
        target.user,
        "--dbname",
        target.dbName,
      ],
      { env: envWithPassword(target) },
    ).status;
  } else {
    // pg_dump runs INSIDE the db container (localhost there) and the
    // custom-format archive streams to the host file over stdout.
    const fd = openSync(output, "w");
    try {
      status = runTool(
        [
          "docker",
          ...composeExecArgv(runner, [
            "pg_dump",
            "--format=custom",
            "--host",
            "127.0.0.1",
            "--username",
            target.user,
            "--dbname",
            target.dbName,
          ]),
        ],
        { env: envWithPassword(target), stdoutFd: fd },
      ).status;
    } finally {
      closeSync(fd);
    }
  }

  if (status !== 0) {
    throw new Error(`pg_dump failed with exit code ${status}`);
  }
  const size = statSync(output).size;

  // Sidecar manifest (spec §9): a backup is DB + release/migration
  // metadata + recovery config pointers. The dump carries the data; the
  // manifest records which migrations were applied so restore-test and
  // upgrade-check can detect a backup that is NEWER than the code.
  const manifest = {
    backup: path.basename(output),
    createdAt: new Date().toISOString(),
    format: "pg_dump-custom",
    schemaMigrations: await listSchemaMigrations(rawUrl),
  };
  writeFileSync(
    `${output}.manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // Path + size only — never the URL or credentials.
  console.log(
    `backup written: ${output} (${size} bytes, pg_dump -Fc, via ${runner.kind === "local" ? "local pg_dump" : `docker compose exec ${runner.service}`})`,
  );
  console.log(`manifest written: ${output}.manifest.json`);
}

/**
 * Best-effort: the applied migration set at backup time. A pre-migration
 * database has no tracking table — the manifest still lands, just empty.
 * Never fails the backup itself.
 */
async function listSchemaMigrations(url: string): Promise<string[]> {
  const db = knex({
    client: "pg",
    connection: { connectionString: url },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 10_000,
  });
  try {
    if (!(await db.schema.hasTable("schema_migration"))) return [];
    const rows = await db("schema_migration").select("name").orderBy("name");
    return rows.map((r: { name: string }) => r.name);
  } catch {
    return [];
  } finally {
    await db.destroy().catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(
    "ops:backup failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
