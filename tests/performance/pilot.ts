import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { createDb } from "../../server/src/db/connection.js";
import { migrate } from "../../server/src/db/migrate.js";
import { hashPassword } from "../../server/src/modules/auth/password.js";
import { assertDisposableDbUrl } from "../helpers/disposable-db.js";
import {
  TEST_DATABASE_URL,
  TEST_MAINTENANCE_DATABASE_URL,
  TEST_MIGRATOR_DATABASE_URL,
  testEnv,
} from "../helpers/fixture.js";

/**
 * `npm run test:performance` (task 4.7, spec §9/§10) — the pilot benchmark.
 *
 * Seeds a DISPOSABLE pilot_<uuid> schema inside gwp_test (never a real
 * DATABASE_URL — the disposable-URL guard fires first): 1 test company,
 * 501 users, 5000 canvases, 100000 published versions, one live draft per
 * canvas. Then boots the real app in-process and drives 50 concurrent
 * sessions — each with its own bearer token and client IP — over the
 * auth/read/write/dashboard routes, recording per-route latency and
 * payload sizes into JSON on stdout.
 *
 * Gate: p95 ≤ 500ms for ordinary APIs on the reference box (4 vCPU /
 * 8 GiB, app+DB — LLM excluded). The gate verdict is reported against the
 * actual host spec; on different hardware the numbers are evidence, not a
 * fabricated pass.
 */

const SEED = { users: 500, canvases: 5000, versionsPerCanvas: 20 };
const SESSIONS = 50;
const REQUESTS_PER_SESSION = 12; // mixed reads + one write per canvas
const PILOT_PASSWORD = "pilot-bench-password";

interface RouteStats {
  count: number;
  errors: number;
  bytes: number;
  latencies: number[];
}

const stats = new Map<string, RouteStats>();
function record(route: string, ms: number, status: number, bytes: number) {
  const s = stats.get(route) ?? { count: 0, errors: 0, bytes: 0, latencies: [] };
  s.count += 1;
  s.bytes += bytes;
  if (status >= 400) s.errors += 1;
  s.latencies.push(ms);
  stats.set(route, s);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

interface TimedResult {
  status: number;
  json: () => unknown;
}

async function timed(
  route: string,
  fn: () => Promise<Response>,
): Promise<TimedResult> {
  const t0 = performance.now();
  const res = await fn();
  const body = Buffer.from(await res.arrayBuffer());
  record(route, performance.now() - t0, res.status, body.byteLength);
  return { status: res.status, json: () => JSON.parse(body.toString()) };
}

async function main(): Promise<void> {
  // Disposable-target proof BEFORE any DDL — same rule as fixtures.
  for (const url of [
    TEST_DATABASE_URL,
    TEST_MIGRATOR_DATABASE_URL,
    TEST_MAINTENANCE_DATABASE_URL,
  ]) {
    assertDisposableDbUrl(url, { envVar: "TEST_*_DATABASE_URL", dbName: "gwp_test" });
  }

  const schema = `pilot_${randomUUID().replaceAll("-", "")}`;
  const admin = createDb(TEST_MAINTENANCE_DATABASE_URL, { poolMax: 2 });
  const runtimeUrl = TEST_DATABASE_URL;
  const runtimeUser = decodeURIComponent(new URL(runtimeUrl).username);
  const migratorUser = decodeURIComponent(
    new URL(TEST_MIGRATOR_DATABASE_URL).username,
  );

  const t0 = Date.now();
  let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
  let runtimeDb: ReturnType<typeof createDb> | undefined;
  try {
    await admin.raw(`CREATE SCHEMA "${schema}"`);
    await admin.raw(
      `GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${migratorUser}"`,
    );
    await admin.raw(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeUser}"`);
    const hasMaintenance =
      (
        await admin.raw(
          `SELECT 1 FROM pg_roles WHERE rolname = 'gwp_maintenance'`,
        )
      ).rows.length > 0;
    if (hasMaintenance) {
      await admin.raw(
        `GRANT USAGE ON SCHEMA "${schema}" TO "gwp_maintenance"`,
      );
    }

    const migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
      searchPath: schema,
      poolMax: 2,
    });
    try {
      await migrate(migratorDb, { mode: "production" });
    } finally {
      await migratorDb.destroy().catch(() => {});
    }
    await admin.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE UPDATE, DELETE ON TABLE "${schema}".audit_event FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE UPDATE, DELETE ON TABLE "${schema}".canvas_version FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE UPDATE ON TABLE "${schema}".write_receipt FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE INSERT, UPDATE, DELETE ON TABLE "${schema}".schema_migration FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE UPDATE, DELETE ON TABLE "${schema}".coaching_session FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE UPDATE ON TABLE "${schema}".coaching_report FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE DELETE ON TABLE "${schema}".report_share FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `REVOKE UPDATE ON TABLE "${schema}".deployment_state FROM "${runtimeUser}"`,
    );
    await admin.raw(
      `GRANT UPDATE (setup_completed_at, seed_version) ON TABLE "${schema}".deployment_state TO "${runtimeUser}"`,
    );

    // ---- Bulk seed (test-only marker: company name + pilot_ schema) ----
    const passwordHash = await hashPassword(PILOT_PASSWORD);
    await admin.raw(
      `INSERT INTO "${schema}".company (name) VALUES ('GWP Pilot Bench — TEST ONLY')`,
    );
    const company = (
      await admin.raw(`SELECT id FROM "${schema}".company LIMIT 1`)
    ).rows[0].id as string;
    await admin.raw(
      `UPDATE "${schema}".deployment_state SET setup_completed_at = now() WHERE singleton_id = 1`,
    );

    const memberRole = (
      await admin.raw(`SELECT id FROM "${schema}".role WHERE key = 'member'`)
    ).rows[0].id as string;
    const managerRole = (
      await admin.raw(`SELECT id FROM "${schema}".role WHERE key = 'manager'`)
    ).rows[0].id as string;

    // One manager + SEED.users members reporting to them.
    const managerId = randomUUID();
    await admin.raw(
      `INSERT INTO "${schema}".app_user
         (id, company_id, email, name, password_hash, status)
       VALUES (?, ?, 'bench.manager@example.test', 'Bench Manager', ?, 'active')`,
      [managerId, company, passwordHash],
    );
    await admin.raw(
      `INSERT INTO "${schema}".user_role (company_id, user_id, role_id)
       VALUES (?, ?, ?)`,
      [company, managerId, managerRole],
    );
    await admin.raw(
      `INSERT INTO "${schema}".app_user
         (company_id, email, name, password_hash, manager_id, status)
       SELECT ?, 'bench.user' || g || '@example.test',
              'Bench User ' || g, ?, ?, 'active'
       FROM generate_series(1, ?) g`,
      [company, passwordHash, managerId, SEED.users],
    );
    await admin.raw(
      `INSERT INTO "${schema}".user_role (company_id, user_id, role_id)
       SELECT ?, u.id, ? FROM "${schema}".app_user u
       WHERE u.email LIKE 'bench.user%@example.test'`,
      [company, memberRole],
    );

    // 5000 canvases — 10 per member.
    await admin.raw(
      `INSERT INTO "${schema}".canvas
         (company_id, owner_user_id, name, created_by)
       SELECT u.company_id, u.id, 'Bench canvas ' || u.id || '-' || g, u.id
       FROM "${schema}".app_user u, generate_series(1, ?) g
       WHERE u.email LIKE 'bench.user%@example.test'`,
      [SEED.canvases / SEED.users],
    );

    // 100000 published versions — canonical-shape body, 20 per canvas.
    const canonical = JSON.parse(
      (await import("node:fs")).readFileSync(
        "tests/fixtures/canvas/canonical.json",
        "utf8",
      ),
    ) as Record<string, unknown>;
    await admin.raw(
      `INSERT INTO "${schema}".canvas_version
         (company_id, canvas_id, version_no, schema_version, body, published_by)
       SELECT c.company_id, c.id, v.g, 1, ?::jsonb, c.owner_user_id
       FROM "${schema}".canvas c, generate_series(1, ?) v(g)`,
      [JSON.stringify(canonical), SEED.versionsPerCanvas],
    );
    // Point current_version_id at v20 of each canvas (composite FK).
    await admin.raw(
      `UPDATE "${schema}".canvas c SET current_version_id = v.id
       FROM "${schema}".canvas_version v
       WHERE v.canvas_id = c.id AND v.company_id = c.company_id
         AND v.version_no = ?`,
      [SEED.versionsPerCanvas],
    );
    // One live draft per canvas so PUT /draft has a CAS row to write.
    await admin.raw(
      `INSERT INTO "${schema}".canvas_draft
         (company_id, canvas_id, base_version_id, revision, schema_version,
          body, source, created_by, updated_by)
       SELECT c.company_id, c.id, c.current_version_id, 1, 1, ?::jsonb,
              'manual', c.owner_user_id, c.owner_user_id
       FROM "${schema}".canvas c`,
      [JSON.stringify(canonical)],
    );

    const seeded = await admin.raw(
      `SELECT (SELECT count(*) FROM "${schema}".app_user) AS users,
              (SELECT count(*) FROM "${schema}".canvas) AS canvases,
              (SELECT count(*) FROM "${schema}".canvas_version) AS versions`,
    );
    const seedMs = Date.now() - t0;

    // ---- Boot the real app on an ephemeral port ----
    runtimeDb = createDb(runtimeUrl, { searchPath: schema });
    const config = loadConfig({
      ...testEnv,
      DATABASE_URL: runtimeUrl,
      DEMO_MODE: "production",
      PORT: "8080", // unused — the harness listens on an ephemeral port
    });
    const app = createApp({ db: runtimeDb, clock: () => new Date(), config });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server!.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // ---- 50 concurrent sessions, warmup excluded ----
    const userIds = (
      await admin.raw(
        `SELECT id, email FROM "${schema}".app_user
         WHERE email LIKE 'bench.user%@example.test'
         ORDER BY email LIMIT ?`,
        [SESSIONS],
      )
    ).rows as { id: string; email: string }[];
    const canvasByUser = new Map<string, string[]>(
      userIds.map((u) => [u.id, []]),
    );
    for (const u of userIds) {
      const rows = (
        await admin.raw(
          `SELECT id FROM "${schema}".canvas
           WHERE owner_user_id = ? ORDER BY created_at LIMIT 10`,
          [u.id],
        )
      ).rows as { id: string }[];
      canvasByUser.set(
        u.id,
        rows.map((r) => r.id),
      );
    }

    async function session(u: { id: string; email: string }, idx: number) {
      const ip = `10.99.${Math.floor(idx / 250)}.${(idx % 250) + 1}`;
      const headers = {
        "Content-Type": "application/json",
        Origin: config.appOrigin,
        "X-Forwarded-For": ip,
      };
      const login = await timed("POST /auth/login", () =>
        fetch(`${base}/api/v1/auth/login`, {
          method: "POST",
          headers,
          body: JSON.stringify({ email: u.email, password: PILOT_PASSWORD }),
        }),
      );
      if (login.status !== 200) return;
      const token = (login.json() as { accessToken: string }).accessToken;
      const auth = { ...headers, Authorization: `Bearer ${token}` };
      const mine = canvasByUser.get(u.id) ?? [];

      for (let i = 0; i < REQUESTS_PER_SESSION; i++) {
        const canvasId = mine[i % mine.length];
        switch (i % 4) {
          case 0:
            await timed("GET /dashboard", () =>
              fetch(`${base}/api/v1/dashboard`, { headers: auth }),
            );
            break;
          case 1:
            await timed("GET /canvases?limit=20", () =>
              fetch(`${base}/api/v1/canvases?limit=20`, { headers: auth }),
            );
            break;
          case 2:
            await timed("GET /canvases/:id", () =>
              fetch(`${base}/api/v1/canvases/${canvasId}`, { headers: auth }),
            );
            break;
          case 3: {
            // CAS write on the session's own draft.
            const detail = await timed("GET /canvases/:id (pre-write)", () =>
              fetch(`${base}/api/v1/canvases/${canvasId}`, { headers: auth }),
            );
            const d = detail.json() as {
              draft?: { revision: number; baseVersionId: string | null };
            };
            if (d.draft) {
              await timed("PUT /canvases/:id/draft", () =>
                fetch(`${base}/api/v1/canvases/${canvasId}/draft`, {
                  method: "PUT",
                  headers: auth,
                  body: JSON.stringify({
                    expectedRevision: d.draft!.revision,
                    baseVersionId: d.draft!.baseVersionId,
                    body: canonical,
                  }),
                }),
              );
            }
            break;
          }
        }
      }
    }

    const runStart = Date.now();
    await Promise.all(userIds.map((u, i) => session(u, i)));
    const runMs = Date.now() - runStart;

    // ---- Report ----
    const routes: Record<string, unknown> = {};
    let allOrdinaryOk = true;
    for (const [route, s] of [...stats.entries()].sort()) {
      const p95 = percentile(s.latencies, 0.95);
      if (route !== "POST /auth/login" && (p95 > 500 || s.errors > 0)) {
        allOrdinaryOk = false;
      }
      routes[route] = {
        count: s.count,
        errors: s.errors,
        p50ms: Math.round(percentile(s.latencies, 0.5) * 10) / 10,
        p95ms: Math.round(p95 * 10) / 10,
        maxMs: Math.round(Math.max(...s.latencies) * 10) / 10,
        totalBytes: s.bytes,
      };
    }
    const cpus = os.cpus().length;
    const memGiB = Math.round(os.totalmem() / 2 ** 30);
    const referenceHost = cpus >= 4 && memGiB >= 8;
    const report = {
      benchmark: "pilot",
      at: new Date().toISOString(),
      host: { cpus, memoryGiB: memGiB, node: process.version },
      seeded: {
        users: Number(seeded.rows[0].users),
        canvases: Number(seeded.rows[0].canvases),
        versions: Number(seeded.rows[0].versions),
        sessions: SESSIONS,
        requestsPerSession: REQUESTS_PER_SESSION,
        seedMs,
      },
      durationMs: runMs,
      routes,
      gate: {
        rule: "p95 <= 500ms for ordinary (non-AI/export) APIs, 0 errors",
        referenceHost: "4 vCPU / 8 GiB, app+DB on one box, LLM excluded",
        thisHostMeetsOrExceedsReference: referenceHost,
        result: referenceHost
          ? allOrdinaryOk
            ? "PASS"
            : "FAIL"
          : "REPORTED-ONLY (host differs from reference spec)",
      },
    };
    console.log(JSON.stringify(report, null, 2));
    if (referenceHost && !allOrdinaryOk) process.exitCode = 1;
  } finally {
    server?.close();
    await runtimeDb?.destroy().catch(() => {});
    await admin
      .raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch(() => {});
    await admin.destroy().catch(() => {});
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("pilot benchmark failed:", err);
    process.exit(1);
  });
}
