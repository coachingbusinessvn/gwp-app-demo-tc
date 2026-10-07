import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrate } from "../../server/src/db/migrate.js";
import { createDb } from "../../server/src/db/connection.js";
import { bootstrapDbRoles } from "../../scripts/ops/bootstrap-db-roles.js";
import { RESTORE_DB } from "../../scripts/ops/restore-test.js";
import {
  fixture,
  testEnv,
  TEST_MAINTENANCE_DATABASE_URL,
  TEST_MIGRATOR_DATABASE_URL,
  type Fixture,
} from "../helpers/fixture.js";
import {
  checkOfflineRuntime,
  dumpFixtureSchema,
  runRecoveryDrill,
  writeBackupManifest,
} from "../helpers/recovery.js";

/**
 * Task 4.6, spec §9 — the restore drill on a clean database, plus the two
 * guarantees that make the bundle honest: no blind schema downgrade and a
 * runtime that works with the Internet cut.
 *
 * The drill dumps the fixture's schema (pg_dump -Fc), restores it into a
 * freshly-created gwp_restore_test database, then proves on the RESTORED
 * copy — through the real app and real logins — that roles/privileges,
 * canvas history, report ACL, BYOK envelope decryption and publishing all
 * survive. The source schema is asserted untouched at the end.
 */

const CANVAS_MARKER = `recovery-${randomUUID().slice(0, 8)}`;
const REPORT_MARKER = `report-${randomUUID().slice(0, 8)}`;
const DRILL_API_KEY = `drill-key-${randomUUID().slice(0, 8)}`;

async function seedDrillData(f: Fixture): Promise<{
  canvasId: string;
  versionId: string;
  reportId: string;
}> {
  // A published canvas snapshot — the historical record the restore must
  // preserve verbatim.
  const canonical = JSON.parse(
    readFileSync("tests/fixtures/canvas/canonical.json", "utf8"),
  ) as { meta: { title: string } };
  canonical.meta.title = CANVAS_MARKER;
  const canvasRes = await f.api("member").post("/api/v1/canvases").send({
    ownerUserId: f.ids.member,
    // meta.title is rewritten from `name` at create — the marker rides it.
    name: CANVAS_MARKER,
    body: canonical,
  });
  expect(canvasRes.status, JSON.stringify(canvasRes.body)).toBe(201);
  const canvasId = canvasRes.body.id as string;
  const pub = await f.api("member").post(`/api/v1/canvases/${canvasId}/publish`).send({
    expectedRevision: 1,
    idempotencyKey: `drill-pub-${randomUUID()}`,
  });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  const versionId = pub.body.versionId as string;

  // A coaching report shared with the member — proves the report ACL and
  // its grants ride the dump/restore instead of being re-created.
  const sessionId = randomUUID();
  await f.db("coaching_session").insert({
    id: sessionId,
    company_id: f.ids.company,
    coach_user_id: f.ids.manager,
    coachee_user_id: f.ids.member,
    occurred_at: new Date(),
    created_by: f.ids.manager,
  });
  const reportId = randomUUID();
  await f.db("coaching_report").insert({
    id: reportId,
    company_id: f.ids.company,
    session_id: sessionId,
    report_version: 1,
    rubric_version: "ORACLE-v3",
    body: { report_markdown: `# Drill\n\n${REPORT_MARKER}` },
    created_by: f.ids.manager,
  });
  await f.db("report_share").insert({
    company_id: f.ids.company,
    report_id: reportId,
    user_id: f.ids.member,
    granted_by: f.ids.manager,
  });

  // BYOK settings — the encrypted envelope must still open under the same
  // APP_KEY after the restore.
  const ai = await f.api("owner").put("/api/v1/settings/ai").send({
    enabled: true,
    baseUrl: "https://llm.internal:8443/v1",
    apiKey: DRILL_API_KEY,
    model: "pilot",
  });
  expect(ai.status, JSON.stringify(ai.body)).toBe(200);

  return { canvasId, versionId, reportId };
}

describe("restore drill (task 4.6, spec §9)", () => {
  it(
    "restores roles, login, canvas history, report ACL, key decrypt and publish on a clean database",
    async () => {
      const f = await fixture({ seeded: true });
      try {
        const seeded = await seedDrillData(f);
        const evidence = await runRecoveryDrill({
          sourceFixture: f,
          targetDatabase: "gwp_restore_test",
          appKey: testEnv.APP_KEY!,
          expected: {
            ...seeded,
            canvasMarker: CANVAS_MARKER,
            reportMarker: REPORT_MARKER,
            aiApiKey: DRILL_API_KEY,
            companyId: f.ids.company,
            sharee: "member",
            denied: "outsider",
            userIds: {
              owner: f.ids.owner,
              admin: f.ids.admin,
              manager: f.ids.manager,
              member: f.ids.member,
              outsider: f.ids.outsider,
            },
          },
        });
        expect(evidence.checks).toMatchObject({
          roles: true,
          login: true,
          canvasHistory: true,
          reportAcl: true,
          keyDecrypt: true,
          publish: true,
        });
        // The drill must never have restored INTO the customer database —
        // only the disposable gwp_restore_test was touched.
        expect(evidence.restoredCustomerDatabase).toBe(false);
        expect(evidence.backupBytes).toBeGreaterThan(0);
        // Measured, not assumed: RTO = restore+verify elapsed, RPO = backup
        // age (manifest createdAt) at restore start. Pilot targets
        // RTO ≤ 4h / RPO ≤ 24h — a drill dataset is far inside both, so a
        // breach means the measurement broke, not that the window shrank.
        expect(typeof evidence.rtoMs).toBe("number");
        expect(evidence.rtoMs).toBeGreaterThan(0);
        expect(evidence.rtoMs).toBeLessThanOrEqual(4 * 3_600_000);
        expect(typeof evidence.rpoAgeMs).toBe("number");
        expect(evidence.rpoAgeMs).toBeGreaterThanOrEqual(0);
        expect(evidence.rpoAgeMs).toBeLessThanOrEqual(24 * 3_600_000);
        // Surface the measured numbers — the evidence file copies them.
        console.info(
          `drill metrics (same-cluster): ${JSON.stringify({
            rtoMs: evidence.rtoMs,
            rpoAgeMs: evidence.rpoAgeMs,
            backupBytes: evidence.backupBytes,
            endpoint: evidence.restoreEndpoint,
          })}`,
        );
      } finally {
        await f.close();
      }
    },
    120_000,
  );

  it(
    "restores into a SEPARATE disposable Postgres cluster (clean-host)",
    async () => {
      // The restore-db service of compose.test.yaml is a second Postgres
      // process with its own tmpfs volume — the closest thing to a clean
      // host in this harness. Roles do not exist there until the shipped
      // bootstrap creates them, exactly like a real clean-cluster restore.
      const restoreAdminUrl =
        process.env.TEST_RESTORE_ADMIN_URL ??
        "postgres://gwp_test:gwp_test@127.0.0.1:54330/gwp_test";
      const restoreRuntimeUrl =
        process.env.TEST_RESTORE_DATABASE_URL ??
        "postgres://gwp_runtime:gwp_runtime@127.0.0.1:54330/gwp_test";
      const expectedEndpoint = (() => {
        const u = new URL(restoreAdminUrl);
        return `${u.hostname}:${u.port}`;
      })();
      const f = await fixture({ seeded: true });
      try {
        const seeded = await seedDrillData(f);
        const evidence = await runRecoveryDrill({
          sourceFixture: f,
          targetDatabase: RESTORE_DB,
          appKey: testEnv.APP_KEY!,
          restoreTarget: {
            adminUrl: restoreAdminUrl,
            runtimeUrl: restoreRuntimeUrl,
            composeService: "restore-db",
          },
          expected: {
            ...seeded,
            canvasMarker: CANVAS_MARKER,
            reportMarker: REPORT_MARKER,
            aiApiKey: DRILL_API_KEY,
            companyId: f.ids.company,
            sharee: "member",
            denied: "outsider",
            userIds: {
              owner: f.ids.owner,
              admin: f.ids.admin,
              manager: f.ids.manager,
              member: f.ids.member,
              outsider: f.ids.outsider,
            },
          },
        });
        expect(evidence.checks).toMatchObject({
          roles: true,
          login: true,
          canvasHistory: true,
          reportAcl: true,
          keyDecrypt: true,
          publish: true,
        });
        expect(evidence.restoredCustomerDatabase).toBe(false);
        expect(evidence.restoreEndpoint).toBe(expectedEndpoint);
        expect(evidence.restoreEndpoint).not.toBe(
          `${new URL(TEST_MAINTENANCE_DATABASE_URL).hostname}:54329`,
        );
        // Two clusters, not one: system_identifier differs per initdb.
        const srcId = await f.maintenanceDb.raw(
          "SELECT system_identifier FROM pg_control_system()",
        );
        const dst = createDb(restoreAdminUrl, { poolMax: 1 });
        try {
          const dstId = await dst.raw(
            "SELECT system_identifier FROM pg_control_system()",
          );
          expect(dstId.rows[0].system_identifier).not.toBe(
            srcId.rows[0].system_identifier,
          );
        } finally {
          await dst.destroy().catch(() => {});
        }
        console.info(
          `drill metrics (clean-cluster): ${JSON.stringify({
            rtoMs: evidence.rtoMs,
            rpoAgeMs: evidence.rpoAgeMs,
            backupBytes: evidence.backupBytes,
            endpoint: evidence.restoreEndpoint,
          })}`,
        );
      } finally {
        await f.close();
      }
    },
    180_000,
  );

  it(
    "ops:restore-test prints machine-readable RTO/RPO metrics",
    async () => {
      // The operator-facing line: `restore-test metrics: {...}` — an
      // operator records it as the drill evidence. Run the real CLI
      // against the clean cluster so the printed numbers are end-to-end.
      const restoreAdminUrl =
        process.env.TEST_RESTORE_ADMIN_URL ??
        "postgres://gwp_test:gwp_test@127.0.0.1:54330/gwp_test";
      const restoreRuntimeUrl =
        process.env.TEST_RESTORE_DATABASE_URL ??
        "postgres://gwp_runtime:gwp_runtime@127.0.0.1:54330/gwp_test";
      const f = await fixture({ seeded: false });
      const dump = path.join(
        os.tmpdir(),
        `gwp-cli-metrics-${process.pid}-${randomUUID().slice(0, 8)}.dump`,
      );
      const restoreAdmin = createDb(restoreAdminUrl, { poolMax: 1 });
      try {
        dumpFixtureSchema(f.schema, dump);
        writeBackupManifest(dump, []);
        // Clean cluster needs the roles a pg_dump never carries — the
        // runbook's bootstrap step — before pg_restore can replay ACLs.
        await bootstrapDbRoles({
          adminUrl: restoreAdminUrl,
          schema: "public",
          allowPasswords: true,
          passwords: {
            gwp_runtime: decodeURIComponent(
              new URL(restoreRuntimeUrl).password,
            ),
            gwp_migrator: decodeURIComponent(
              new URL(TEST_MIGRATOR_DATABASE_URL).password,
            ),
            gwp_maintenance:
              process.env.GWP_MAINTENANCE_PASSWORD ?? "gwp_maintenance",
          },
        });
        const res = spawnSync(
          path.resolve("node_modules/.bin/tsx"),
          [
            "scripts/ops/restore-test.ts",
            "--backup",
            dump,
            "--target",
            restoreAdminUrl,
          ],
          {
            cwd: path.resolve("."),
            env: {
              ...process.env,
              GWP_OPS_COMPOSE_FILE: "compose.test.yaml",
              GWP_OPS_DB_SERVICE: "restore-db",
            },
            encoding: "utf8",
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        expect(res.status, res.stderr + res.stdout).toBe(0);
        const line = res.stdout
          .split("\n")
          .find((l) => l.startsWith("restore-test metrics: "));
        expect(line, res.stdout).toBeDefined();
        const metrics = JSON.parse(
          line!.slice("restore-test metrics: ".length),
        ) as { rtoMs?: unknown; rpoAgeMs?: unknown; backupBytes?: unknown };
        expect(typeof metrics.rtoMs).toBe("number");
        expect(metrics.rtoMs as number).toBeGreaterThan(0);
        expect(metrics.rtoMs as number).toBeLessThanOrEqual(4 * 3_600_000);
        expect(typeof metrics.rpoAgeMs).toBe("number");
        expect(metrics.rpoAgeMs as number).toBeGreaterThanOrEqual(0);
        expect(metrics.rpoAgeMs as number).toBeLessThanOrEqual(
          24 * 3_600_000,
        );
        expect(typeof metrics.backupBytes).toBe("number");
        expect(metrics.backupBytes as number).toBeGreaterThan(0);
      } finally {
        await restoreAdmin
          .raw(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`)
          .catch(() => {});
        await restoreAdmin.destroy().catch(() => {});
        for (const file of [dump, `${dump}.manifest.json`]) {
          try {
            unlinkSync(file);
          } catch {
            /* temp artifacts are best-effort cleanup */
          }
        }
        await f.close();
      }
    },
    180_000,
  );

  it("refuses migrations when the database is ahead of the code — no blind downgrade", async () => {
    const f = await fixture({ seeded: false });
    try {
      // A database stamped with a migration this build does not know can
      // only come from a NEWER release — upgrading tooling must refuse to
      // run against it rather than silently skip.
      await f.maintenanceDb(`${f.schema}.schema_migration`).insert({
        name: "9999-future-release",
      });
      const migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
        searchPath: f.schema,
        poolMax: 1,
      });
      try {
        await expect(migrate(migratorDb)).rejects.toThrow(
          /9999-future-release/,
        );
      } finally {
        await migratorDb.destroy().catch(() => {});
      }
    } finally {
      await f.close();
    }
  });

  it("ships no external network dependency in the served runtime", () => {
    // Internet cut: every asset the app serves must be bundled locally —
    // no CDN font, script, stylesheet or image origin may be referenced.
    const offenders = checkOfflineRuntime();
    expect(offenders).toEqual([]);
  });
});
