import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrate } from "../../server/src/db/migrate.js";
import { createDb } from "../../server/src/db/connection.js";
import {
  fixture,
  testEnv,
  TEST_MIGRATOR_DATABASE_URL,
  type Fixture,
} from "../helpers/fixture.js";
import {
  checkOfflineRuntime,
  runRecoveryDrill,
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
      } finally {
        await f.close();
      }
    },
    120_000,
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
