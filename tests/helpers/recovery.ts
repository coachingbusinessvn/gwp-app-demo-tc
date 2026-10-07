import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import type { Knex } from "knex";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { createDb } from "../../server/src/db/connection.js";
import {
  decryptSecret,
  parseKeyRing,
  type SecretEnvelope,
} from "../../server/src/security/secrets.js";
import {
  composeExecArgv,
  envWithPassword,
  parsePgUrl,
  resolvePgRunner,
  runTool,
  type PgRunner,
} from "../../scripts/ops/pg-runner.js";
import { bootstrapDbRoles } from "../../scripts/ops/bootstrap-db-roles.js";
import {
  DISPOSABLE_HOSTS,
  restoreArchive,
  RESTORE_DB,
} from "../../scripts/ops/restore-test.js";
import {
  FIXTURE_PASSWORD,
  personaEmail,
  type Persona,
} from "./seed-personas.js";
import {
  TEST_DATABASE_URL,
  TEST_MAINTENANCE_DATABASE_URL,
  TEST_MIGRATOR_DATABASE_URL,
  testEnv,
  type Fixture,
} from "./fixture.js";

/**
 * Task 4.6 (spec §9) — the restore DRILL harness.
 *
 * runRecoveryDrill proves a pg_dump -Fc backup of the fixture schema
 * recreates a working deployment inside the disposable restore database
 * (scripts/ops/restore-test.ts's constant — gwp_restore_test). Every check
 * runs against the RESTORED copy through the real app surface: the source
 * database is asserted untouched at the end and the drill never writes to
 * it after the dump.
 *
 * Postgres tools run via pg-runner like the shipped ops scripts: local
 * binaries if present, else `docker compose exec` into the disposable
 * test-db service — so the drill exercises the same path an operator on a
 * tool-less host would use.
 */

const COMPOSE_FILE = process.env.GWP_OPS_COMPOSE_FILE ?? "compose.test.yaml";
const DB_SERVICE = process.env.GWP_OPS_DB_SERVICE ?? "test-db";

export interface DrillExpected {
  canvasId: string;
  versionId: string;
  canvasMarker: string;
  reportId: string;
  reportMarker: string;
  aiApiKey: string;
  companyId: string;
  sharee: Persona;
  denied: Persona;
  /** The seeded persona user ids — identical in the restored copy. */
  userIds: Record<Persona, string>;
}

export interface RecoveryDrillEvidence {
  checks: {
    roles: boolean;
    login: boolean;
    canvasHistory: boolean;
    reportAcl: boolean;
    keyDecrypt: boolean;
    publish: boolean;
  };
  /** Always false — the drill restores only into the disposable target. */
  restoredCustomerDatabase: boolean;
  backupBytes: number;
  elapsedMs: number;
  /**
   * Measured RTO: elapsed wall time of the restore + verification work on
   * the target — for a clean cluster that includes creating the roles a
   * pg_dump never carries (the real clean-host sequence). Never includes
   * the backup itself.
   */
  rtoMs: number;
  /**
   * Measured RPO: age of the backup at the moment restore started, taken
   * from the sidecar manifest's createdAt (same contract as ops:backup).
   */
  rpoAgeMs: number;
  /** host:port of the cluster the restore landed on — same-cluster drills
   *  report the test-db endpoint; clean-cluster drills the restore-db one. */
  restoreEndpoint: string;
  migrations: string[];
  envelopeKeyVersions: string[];
}

/**
 * A restore destination OTHER than the source cluster (Phase-4 clean-host
 * evidence): the drill recreates gwp_restore_test on a fresh disposable
 * Postgres — roles bootstrapped there by the shipped script before and
 * after pg_restore, exactly like the runbook sequence.
 */
export interface DrillRestoreTarget {
  /** Superuser URL on the restore cluster (any database — used for
   *  drop/create, the pre/post bootstrap and the post-restore checks). */
  adminUrl: string;
  /** Runtime-role URL the restored app connects through (password must be
   *  what the bootstrap sets on that cluster). */
  runtimeUrl: string;
  /** Compose service hosting that cluster, for the tool fallback runner. */
  composeService: string;
}

/** compose.test.yaml restore-db port — the only port resetCleanCluster will
 *  ever drop roles on (the gwp_test superuser itself is never touched). */
const CLEAN_CLUSTER_PORT = "54330";

/** App roles a clean restore target must be provably empty of. */
const APP_ROLES = ["gwp_runtime", "gwp_migrator", "gwp_maintenance"];

/**
 * Cross-file mutual exclusion for the disposable clean cluster: parallel
 * vitest FILES would otherwise drop/recreate the same gwp_restore_test
 * mid-flight (a concurrent drill's reset wiped roles between another
 * leg's drop and assert). Every leg touching restore-db must hold this
 * advisory lock for the whole leg — reset, bootstrap, restore, checks.
 * Taken on a dedicated checked-out connection (a pooled conn could be
 * idle-reaped mid-leg and silently drop the lock). Cooperative — every
 * caller locks via the adminUrl database on the same cluster.
 * Returns the release function.
 */
export async function acquireCleanCluster(
  adminUrl: string,
): Promise<() => Promise<void>> {
  const t = parsePgUrl(adminUrl, "clean-cluster adminUrl");
  if (!DISPOSABLE_HOSTS.has(t.host) || t.port !== CLEAN_CLUSTER_PORT) {
    throw new Error(
      `clean-cluster lock only applies to the disposable restore-db ` +
        `service (${CLEAN_CLUSTER_PORT}) — got ${t.host}:${t.port}`,
    );
  }
  const db = createDb(adminUrl, { poolMax: 1 });
  let conn: { query: (sql: string) => Promise<unknown> };
  try {
    conn = (await db.client.acquireConnection()) as typeof conn;
  } catch (err) {
    await db.destroy().catch(() => {});
    throw new Error(
      `restore-db not reachable on ${t.port} — run \`npm run db:test:up\``,
      { cause: err },
    );
  }
  // Blocks server-side until the lock is ours.
  await conn.query(
    `SELECT pg_advisory_lock(hashtext('gwp-restore-cluster'))`,
  );
  return async () => {
    try {
      await conn.query(
        `SELECT pg_advisory_unlock(hashtext('gwp-restore-cluster'))`,
      );
    } catch {
      /* conn already gone — process exit releases session locks anyway */
    }
    try {
      await db.client.releaseConnection(conn);
    } catch {
      /* best effort */
    }
    await db.destroy().catch(() => {});
  };
}

/**
 * Return a clean disposable cluster to a pre-bootstrap state so every
 * clean-host drill proves the full bootstrap-on-empty sequence, not a warm
 * run against leftover roles: drop gwp_restore_test, then DROP OWNED BY +
 * DROP ROLE for the app roles, and assert no gwp_* app role remains.
 *
 * Guarded harder than the rest of the drill — role drops are too
 * destructive to aim anywhere but the disposable restore-db service: the
 * host must be disposable-local AND the port must be the compose
 * restore-db port. Callers that mutate the cluster hold
 * acquireCleanCluster() first.
 */
export async function resetCleanCluster(adminUrl: string): Promise<void> {
  const t = parsePgUrl(adminUrl, "clean-cluster adminUrl");
  if (!DISPOSABLE_HOSTS.has(t.host) || t.port !== CLEAN_CLUSTER_PORT) {
    throw new Error(
      `resetCleanCluster only runs on the disposable restore-db service ` +
        `(${CLEAN_CLUSTER_PORT}) — refusing to drop roles on ${t.host}:${t.port}`,
    );
  }
  const db = createDb(adminUrl, { poolMax: 1 });
  try {
    try {
      await db.raw("select 1");
    } catch (err) {
      throw new Error(
        `restore-db not reachable on ${t.port} — run \`npm run db:test:up\``,
        { cause: err },
      );
    }
    await db.raw(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
    for (const role of APP_ROLES) {
      const exists = await db.raw(
        "select 1 from pg_roles where rolname = ?",
        [role],
      );
      if (exists.rows.length > 0) {
        await db.raw(`DROP OWNED BY "${role}"`);
        await db.raw(`DROP ROLE "${role}"`);
      }
    }
    // Proof of empty: every gwp_* role except the cluster's own superuser
    // (gwp_test, which owns the postgres we are connected through).
    const left = await db.raw(
      `select count(*) as n from pg_roles ` +
        `where rolname like 'gwp\\_%' escape '\\' and rolname <> 'gwp_test'`,
    );
    if (Number(left.rows[0].n) !== 0) {
      throw new Error(
        `clean-cluster reset left gwp_* roles behind: ` +
          JSON.stringify(left.rows),
      );
    }
  } finally {
    await db.destroy().catch(() => {});
  }
}

function maintenanceTarget(): ReturnType<typeof parsePgUrl> {
  return parsePgUrl(TEST_MAINTENANCE_DATABASE_URL, "TEST_MAINTENANCE_DATABASE_URL");
}

function runnerFor(tools: string[]): PgRunner {
  return resolvePgRunner({
    tools,
    composeFile: COMPOSE_FILE,
    dbService: DB_SERVICE,
  });
}

/** pg_dump -Fc of ONE schema — the fixture's tenant slice of gwp_test. */
function dumpSchema(
  runner: PgRunner,
  target: ReturnType<typeof parsePgUrl>,
  schema: string,
  output: string,
): void {
  if (runner.kind === "local") {
    const res = runTool(
      [
        "pg_dump",
        "--format=custom",
        `--schema=${schema}`,
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
    );
    if (res.status !== 0) throw new Error(`pg_dump exited ${res.status}`);
    return;
  }
  const fd = openSync(output, "w");
  try {
    const res = runTool(
      [
        "docker",
        ...composeExecArgv(runner, [
          "pg_dump",
          "--format=custom",
          `--schema=${schema}`,
          "--host",
          "127.0.0.1",
          "--username",
          target.user,
          "--dbname",
          target.dbName,
        ]),
      ],
      { env: envWithPassword(target), stdoutFd: fd },
    );
    if (res.status !== 0) throw new Error(`pg_dump exited ${res.status}`);
  } finally {
    closeSync(fd);
  }
}

/** Same credentials/host, different database — used to aim a URL at the
 *  restored gwp_restore_test (exported for the upgrade rehearsal). */
export function urlForDb(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function urlPassword(url: string): string | undefined {
  const password = new URL(url).password;
  return password === "" ? undefined : decodeURIComponent(password);
}

async function dropRestoreDb(admin: Knex): Promise<void> {
  await admin.raw(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
}

/** pg_dump -Fc of the fixture schema — exported for the upgrade rehearsal. */
export function dumpFixtureSchema(schema: string, output: string): void {
  dumpSchema(runnerFor(["pg_dump"]), maintenanceTarget(), schema, output);
}

/**
 * Sidecar manifest in the exact shape ops:backup writes — upgrade-check
 * reads schemaMigrations from it, restore-test reads createdAt for the
 * measured RPO age. Returns the createdAt ISO stamped into the file.
 */
export function writeBackupManifest(
  dumpPath: string,
  schemaMigrations: string[],
): string {
  const createdAt = new Date().toISOString();
  writeFileSync(
    `${dumpPath}.manifest.json`,
    JSON.stringify(
      {
        backup: path.basename(dumpPath),
        createdAt,
        format: "pg_dump-custom",
        schemaMigrations,
      },
      null,
      2,
    ) + "\n",
  );
  return createdAt;
}

export async function runRecoveryDrill(opts: {
  sourceFixture: Fixture;
  targetDatabase?: string;
  appKey: string;
  /**
   * Restore onto a DIFFERENT disposable cluster (compose.test.yaml's
   * restore-db) instead of beside the source — the clean-host proof.
   */
  restoreTarget?: DrillRestoreTarget;
  expected: DrillExpected;
}): Promise<RecoveryDrillEvidence> {
  const startedAt = Date.now();
  const source = maintenanceTarget();
  // The drill target is a compile-time constant of restore-test.ts — a
  // caller may pass it for readability but it can never be changed.
  if (opts.targetDatabase && opts.targetDatabase !== RESTORE_DB) {
    throw new Error(
      `drill target is fixed to ${RESTORE_DB} — got "${opts.targetDatabase}"`,
    );
  }
  const clean = opts.restoreTarget;
  const restoreTarget = clean
    ? parsePgUrl(clean.adminUrl, "restoreTarget.adminUrl")
    : source;
  const runtimeTarget = clean
    ? parsePgUrl(clean.runtimeUrl, "restoreTarget.runtimeUrl")
    : undefined;
  // Same guard as the shipped script: a restore target must be a
  // disposable-local host — the constant database name is not enough.
  if (clean) {
    for (const t of [restoreTarget, runtimeTarget!]) {
      if (!DISPOSABLE_HOSTS.has(t.host)) {
        throw new Error(
          `restoreTarget host "${t.host}" is not a disposable-local ` +
            "target (127.0.0.1/localhost/::1) — refusing to restore there",
        );
      }
    }
  }
  const schema = opts.sourceFixture.schema;
  const dump = path.join(
    os.tmpdir(),
    `gwp-drill-${process.pid}-${randomSuffix()}.dump`,
  );

  // On a clean cluster the tools must run against that cluster's compose
  // service, not the source's.
  const restoreRunner = clean
    ? resolvePgRunner({
        tools: ["psql", "pg_restore"],
        composeFile: COMPOSE_FILE,
        dbService: clean.composeService,
      })
    : runnerFor(["psql", "pg_restore"]);
  const rolePasswords = {
    gwp_migrator: urlPassword(TEST_MIGRATOR_DATABASE_URL),
    gwp_runtime: runtimeTarget?.password ?? urlPassword(TEST_DATABASE_URL),
    gwp_maintenance: process.env.GWP_MAINTENANCE_PASSWORD ?? "gwp_maintenance",
  };

  const admin = createDb(TEST_MAINTENANCE_DATABASE_URL, { poolMax: 1 });
  let restored: Knex | undefined;
  let restoredAdmin: Knex | undefined;
  // Held for the WHOLE clean leg — parallel vitest files share the one
  // disposable restore-db cluster and its single gwp_restore_test.
  let releaseClean: (() => Promise<void>) | undefined;
  try {
    // 1. Backup the fixture schema (+ its sidecar manifest, same shape as
    //    ops:backup), then restore it into gwp_restore_test through the
    //    SHIPPED restore path (restore-test.ts internals).
    dumpSchema(runnerFor(["pg_dump"]), source, schema, dump);
    const backupBytes = statSync(dump).size;
    const migRows = await admin.raw(
      `select coalesce(array_agg(name order by name), '{}') as migrations ` +
        `from "${schema}".schema_migration`,
    );
    const backupCreatedAt = writeBackupManifest(
      dump,
      (migRows.rows[0].migrations as string[]) ?? [],
    );

    // Prove bootstrap-on-empty every run: wipe the clean cluster back to
    // its fresh state BEFORE the clock starts (harness setup — a real
    // clean host starts empty, so the wipe is not restore work). The
    // cluster lock is taken first so a parallel test file cannot
    // drop/recreate gwp_restore_test underneath this leg.
    if (clean) {
      releaseClean = await acquireCleanCluster(clean.adminUrl);
      await resetCleanCluster(clean.adminUrl);
    }

    // The RTO clock starts when restore work begins on the target — on a
    // clean cluster that includes creating the roles a pg_dump never
    // carries (pg_restore's OWNER/ACL replay fails without them).
    const restoreStartedAt = Date.now();
    if (clean) {
      await bootstrapDbRoles({
        adminUrl: clean.adminUrl,
        schema: "public",
        allowPasswords: true,
        passwords: rolePasswords,
      });
    }
    const info = await restoreArchive(restoreTarget, dump, restoreRunner);
    if (clean) {
      // Grants/revokes on the restored schema — the same step the runbook
      // runs on a clean host once the dump lands.
      await bootstrapDbRoles({
        adminUrl: urlForDb(clean.adminUrl, RESTORE_DB),
        schema,
        allowPasswords: true,
        passwords: rolePasswords,
      });
    }

    // 2. Roles + privileges: pg_dump carries object ACLs but NOT cluster
    //    roles — they must already exist (bootstrap-db-roles on a clean
    //    cluster). Verify both here.
    restoredAdmin = createDb(urlForDb(restoreTarget.url, RESTORE_DB), {
      poolMax: 1,
      searchPath: schema,
    });
    const priv = await restoredAdmin.raw(
      `SELECT
         has_schema_privilege('gwp_runtime', ?, 'USAGE') AS rt_usage,
         has_table_privilege('gwp_runtime', ?, 'SELECT') AS rt_select,
         has_table_privilege('gwp_runtime', ?, 'DELETE') AS rt_audit_delete,
         has_table_privilege('gwp_maintenance', ?, 'DELETE') AS mt_ai_delete,
         has_schema_privilege('gwp_migrator', ?, 'CREATE') AS mg_create`,
      [
        schema,
        `${schema}.company`,
        `${schema}.audit_event`,
        `${schema}.ai_run`,
        schema,
      ],
    );
    const p = priv.rows[0];
    const roles =
      info.rolesMissing.length === 0 &&
      p.rt_usage === true &&
      p.rt_select === true &&
      p.rt_audit_delete === false &&
      p.mt_ai_delete === true &&
      p.mg_create === true;

    // 3. A full app on the restored DB over the RUNTIME credential — the
    //    same account production uses, so grant drift fails loudly.
    const runtimeUrl = urlForDb(
      clean ? clean.runtimeUrl : TEST_DATABASE_URL,
      RESTORE_DB,
    );
    restored = createDb(runtimeUrl, {
      searchPath: schema,
      poolMax: 3,
    });
    const config = loadConfig({
      ...testEnv,
      DATABASE_URL: runtimeUrl,
    });
    const app: Express = createApp({ db: restored, clock: () => new Date(), config });
    const login = async (persona: Persona): Promise<string | null> => {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .set("Origin", config.appOrigin)
        .send({ email: personaEmail(persona), password: FIXTURE_PASSWORD });
      return res.status === 200
        ? (res.body as { accessToken: string }).accessToken
        : null;
    };
    const get = (token: string, url: string) =>
      request(app)
        .get(url)
        .set("Origin", config.appOrigin)
        .set("Authorization", `Bearer ${token}`);
    const post = (token: string, url: string, body: Record<string, unknown>) =>
      request(app)
        .post(url)
        .set("Origin", config.appOrigin)
        .set("Authorization", `Bearer ${token}`)
        .send(body);

    const ownerToken = await login("owner");
    const shareeToken = await login(opts.expected.sharee);
    const deniedToken = await login(opts.expected.denied);
    const loginOk = !!(ownerToken && shareeToken && deniedToken);

    // 4. Canvas history: the published snapshot is listed and intact.
    let canvasHistory = false;
    if (ownerToken) {
      const list = await get(
        ownerToken,
        `/api/v1/canvases/${opts.expected.canvasId}/versions`,
      );
      if (process.env.DEBUG_DRILL) {
        console.error("versions list:", list.status, JSON.stringify(list.body).slice(0, 300));
      }
      const hit = (list.body?.versions ?? list.body ?? []) as {
        id?: string;
      }[];
      if (list.status === 200) {
        const found = Array.isArray(hit)
          ? hit.some((v) => v.id === opts.expected.versionId)
          : false;
        const detail = await get(
          ownerToken,
          `/api/v1/canvases/${opts.expected.canvasId}/versions/${opts.expected.versionId}`,
        );
        if (process.env.DEBUG_DRILL) {
          console.error("version detail:", detail.status, JSON.stringify(detail.body).slice(0, 300), "found:", found);
        }
        canvasHistory =
          found &&
          detail.status === 200 &&
          JSON.stringify(detail.body).includes(opts.expected.canvasMarker);
      }
    }

    // 5. Report ACL survived: sharee reads, outsider stays blind (404).
    let reportAcl = false;
    if (shareeToken && deniedToken) {
      const allowed = await get(
        shareeToken,
        `/api/v1/reports/${opts.expected.reportId}`,
      );
      const denied = await get(
        deniedToken,
        `/api/v1/reports/${opts.expected.reportId}`,
      );
      reportAcl =
        allowed.status === 200 &&
        JSON.stringify(allowed.body).includes(opts.expected.reportMarker) &&
        denied.status === 404;
    }

    // 6. The BYOK envelope on the restored row opens under the drill ring.
    let keyDecrypt = false;
    {
      const row = await restoredAdmin("setting")
        .where({ company_id: opts.expected.companyId, key: "ai" })
        .select("value")
        .first();
      const env = (row?.value as { keyEnvelope?: SecretEnvelope } | undefined)
        ?.keyEnvelope;
      if (env) {
        keyDecrypt =
          decryptSecret(
            env,
            parseKeyRing(opts.appKey),
            opts.expected.companyId,
          ) === opts.expected.aiApiKey;
      }
    }

    // 7. The write path works on the restored copy: create + publish v1.
    let publish = false;
    if (shareeToken) {
      // Canvas bodies are schema-validated at create — reuse the canonical
      // fixture shape so the publish path itself is what is on trial.
      const body = JSON.parse(
        readFileSync("tests/fixtures/canvas/canonical.json", "utf8"),
      ) as Record<string, unknown>;
      const created = await post(shareeToken, "/api/v1/canvases", {
        ownerUserId: opts.expected.userIds[opts.expected.sharee],
        name: "restored-publish",
        body,
      });
      if (process.env.DEBUG_DRILL) {
        console.error("create:", created.status, JSON.stringify(created.body).slice(0, 300));
      }
      if (created.status === 201) {
        const pub = await post(
          shareeToken,
          `/api/v1/canvases/${created.body.id}/publish`,
          { expectedRevision: 1, idempotencyKey: `drill-${randomSuffix()}` },
        );
        if (process.env.DEBUG_DRILL) {
          console.error("publish:", pub.status, JSON.stringify(pub.body).slice(0, 300));
        }
        publish = pub.status === 200;
      }
    }

    // 8. The customer database was never the restore target: source schema
    //    and its rows are still there.
    const srcCheck = await admin.raw(
      `SELECT (SELECT count(*) FROM "${schema}".company) AS companies`,
    );
    const restoredCustomerDatabase = Number(srcCheck.rows[0].companies) !== 1;

    return {
      checks: {
        roles,
        login: loginOk,
        canvasHistory,
        reportAcl,
        keyDecrypt,
        publish,
      },
      restoredCustomerDatabase,
      backupBytes,
      elapsedMs: Date.now() - startedAt,
      rtoMs: Date.now() - restoreStartedAt,
      rpoAgeMs: Math.max(
        0,
        restoreStartedAt - Date.parse(backupCreatedAt),
      ),
      restoreEndpoint: `${restoreTarget.host}:${restoreTarget.port}`,
      migrations: info.migrations,
      envelopeKeyVersions: info.envelopeKeyVersions,
    };
  } finally {
    await restored?.destroy().catch(() => {});
    await restoredAdmin?.destroy().catch(() => {});
    if (clean) {
      // The restore landed on the clean cluster — drop it THERE only. A
      // same-named database on the source cluster may belong to another
      // worker's in-flight drill; it is not ours to drop.
      const dropAdmin = createDb(clean.adminUrl, { poolMax: 1 });
      await dropRestoreDb(dropAdmin).catch(() => {});
      await dropAdmin.destroy().catch(() => {});
    } else {
      await dropRestoreDb(admin).catch(() => {});
    }
    // Release AFTER the drop — the cluster is exclusively ours until the
    // leg has fully vacated it.
    await releaseClean?.();
    await admin.destroy().catch(() => {});
    for (const file of [dump, `${dump}.manifest.json`]) {
      try {
        unlinkSync(file);
      } catch {
        /* temp dump best-effort cleanup */
      }
    }
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------------ *
 * Offline-runtime scan: the served surface must carry no reference that
 * makes a browser fetch an external origin (spec §9 — the deployment may
 * sit behind a cut Internet link). Hyperlinks (<a href>) are user-driven
 * and fine; resource loads, CSS imports and API fetches are not.
 * ------------------------------------------------------------------ */

const SCAN_FILES = [
  "index.html",
  "dashboard.html",
  "employee.html",
  "canvas.html",
  "admin.html",
  "activate.html",
  "assets/gwp.css",
  "assets/fonts.css",
  "assets/app.js",
];
const SCAN_DIRS = [
  "assets/fonts",
  "web/admin",
  "web/canvas",
  "web/ai",
  "web/coaching",
  "canvas-online",
  "coaching-report",
];

const EXTERNAL_RESOURCE_PATTERNS = [
  /<script[^>]+\bsrc\s*=\s*["']https?:\/\//i,
  /<link[^>]+\bhref\s*=\s*["']https?:\/\//i,
  /<img[^>]+\bsrc\s*=\s*["']https?:\/\//i,
  /<source[^>]+\bsrc\s*=\s*["']https?:\/\//i,
  /<iframe[^>]+\bsrc\s*=\s*["']https?:\/\//i,
  /@import\s/,
  /url\(\s*["']?https?:\/\//i,
  /\bfetch\(\s*["']https?:\/\//i,
  /\bEventSource\(\s*["']https?:\/\//i,
  /\bsendBeacon\(\s*["']https?:\/\//i,
  /\bimport\(\s*["']https?:\/\//i,
];

/** Returns offending `file:line` entries — empty means offline-clean. */
export function checkOfflineRuntime(repoRoot = "."): string[] {
  const offenders: string[] = [];
  const scan = (file: string) => {
    const abs = path.join(repoRoot, file);
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (EXTERNAL_RESOURCE_PATTERNS.some((re) => re.test(line))) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  };
  for (const f of SCAN_FILES) scan(f);
  for (const dir of SCAN_DIRS) {
    const abs = path.join(repoRoot, dir);
    for (const entry of readdirSync(abs)) {
      if (/\.(html|js|css)$/.test(entry)) scan(path.join(dir, entry));
    }
  }
  return offenders;
}
