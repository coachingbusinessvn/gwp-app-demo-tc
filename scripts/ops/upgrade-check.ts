import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDb } from "../../server/src/db/connection.js";
import { migrationStatus } from "../../server/src/db/migrate.js";
import { parsePgUrl } from "./pg-runner.js";

/**
 * `npm run ops:upgrade-check` (task 4.6, spec §9) — the pre-upgrade gate.
 * Run inside the maintenance window BEFORE deploying a new image:
 *
 *   1. connects with the maintenance credential and reads schema_migration
 *      — REFUSES when the database carries migrations this build does not
 *      know (a newer release wrote them; rolling this build in would be a
 *      blind downgrade);
 *   2. lists the pending migrations this build will apply — the operator
 *      confirms the upgrade actually steps forward;
 *   3. verifies a backup exists and is younger than the RPO target
 *      (default 24h — pilot goal, not an SLA), so a failed upgrade has a
 *      restore point inside the loss window the business accepted.
 *
 * Exit 0 = safe to proceed; exit 1 = stop. Read-only — it never writes.
 *
 * Migration locking is built into the migrator itself
 * (pg_advisory_xact_lock per migration, server/src/db/migrate.ts) so the
 * one-shot `migrate` compose service is safe to re-run; this gate exists
 * to catch the unsafe directions before that lock ever matters.
 */

const USAGE = `usage: npm run ops:upgrade-check -- [options]

  --url <postgres-url>        DB URL — defaults to MAINTENANCE_DATABASE_URL,
                              then DATABASE_URL
  --backup <file.dump>        Backup taken for this upgrade (required)
  --max-backup-age-hours <n>  RPO ceiling for the backup (default: 24)
`;

function parseArgs(argv: string[]): {
  url?: string;
  backup?: string;
  maxAgeHours: number;
} {
  const out: { url?: string; backup?: string; maxAgeHours: number } = {
    maxAgeHours: 24,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--url":
        out.url = next();
        break;
      case "--backup":
        out.backup = next();
        break;
      case "--max-backup-age-hours":
        out.maxAgeHours = Number(next());
        if (!Number.isFinite(out.maxAgeHours) || out.maxAgeHours <= 0) {
          throw new Error("--max-backup-age-hours must be a positive number");
        }
        break;
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

interface BackupManifest {
  backup?: string;
  createdAt?: string;
  schemaMigrations?: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawUrl =
    args.url ?? process.env.MAINTENANCE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      "no database URL — pass --url or set MAINTENANCE_DATABASE_URL/DATABASE_URL",
    );
  }
  parsePgUrl(rawUrl, "database URL"); // shape check; the URL itself is never printed
  if (!args.backup) throw new Error("--backup is required");

  const problems: string[] = [];

  // --- backup freshness ---
  const backup = path.resolve(args.backup);
  if (!existsSync(backup) || statSync(backup).size === 0) {
    problems.push(`backup missing or empty: ${backup}`);
  } else {
    const ageH = (Date.now() - statSync(backup).mtimeMs) / 3_600_000;
    if (ageH > args.maxAgeHours) {
      problems.push(
        `backup is ${ageH.toFixed(1)}h old — beyond the ${args.maxAgeHours}h ` +
          "RPO ceiling; take a fresh backup before upgrading",
      );
    }
    // A sidecar manifest (ops:backup) lets us detect a backup from a
    // NEWER release before anything runs.
    const sidecar = `${backup}.manifest.json`;
    if (existsSync(sidecar)) {
      const m = JSON.parse(readFileSync(sidecar, "utf8")) as BackupManifest;
      const known = new Set(
        (await import("../../server/src/db/migrate.js")).MIGRATIONS.map(
          (x) => x.name,
        ),
      );
      const unknown = (m.schemaMigrations ?? []).filter((n) => !known.has(n));
      if (unknown.length > 0) {
        problems.push(
          `backup was taken from a NEWER schema (unknown migrations: ` +
            `${unknown.join(", ")}) — restore requires the newer build`,
        );
      }
    }
  }

  // --- schema direction ---
  const db = createDb(rawUrl, { poolMax: 1 });
  let pending: string[] = [];
  try {
    const status = await migrationStatus(db);
    pending = status.pending;
    if (status.unknown.length > 0) {
      problems.push(
        `database is ahead of this build (unknown migrations: ` +
          `${status.unknown.join(", ")}) — do NOT deploy this build; ` +
          "upgrade the app instead (no blind downgrade, spec §9)",
      );
    }
  } finally {
    await db.destroy().catch(() => {});
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`upgrade-check FAIL: ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `upgrade-check OK: ${pending.length} pending migration(s)` +
      (pending.length ? ` — ${pending.join(", ")}` : "") +
      "; backup within RPO; schema compatible with this build",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      "ops:upgrade-check failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
