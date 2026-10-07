import { randomUUID } from "node:crypto";
import {
  readFileSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { createDb } from "../../server/src/db/connection.js";
import { migrate, migrationStatus } from "../../server/src/db/migrate.js";
import {
  decryptSecret,
  encryptSecret,
  parseKeyRing,
  type SecretEnvelope,
} from "../../server/src/security/secrets.js";
import { bootstrapDbRoles } from "../../scripts/ops/bootstrap-db-roles.js";
import { checkUpgrade } from "../../scripts/ops/upgrade-check.js";
import { assertConnectedToDisposableDb } from "../helpers/disposable-db.js";
import {
  TEST_DATABASE_URL,
  TEST_MAINTENANCE_DATABASE_URL,
  TEST_MIGRATOR_DATABASE_URL,
  testEnv,
} from "../helpers/fixture.js";
import {
  dumpFixtureSchema,
  writeBackupManifest,
} from "../helpers/recovery.js";
import {
  FIXTURE_PASSWORD,
  generatePersonaIds,
  personaEmail,
  seedCompanyWithPersonas,
  type Persona,
} from "../helpers/seed-personas.js";

/**
 * Phase3→4 upgrade rehearsal (spec §9 exit gate): reproduce a Phase-3
 * deployment on a disposable schema — migrated only through 0005-ai, seeded
 * with Phase-3-era data (owner/member users, a published canvas version,
 * an encrypted BYOK AI settings envelope) — then walk the real upgrade
 * path on it:
 *
 *   pg_dump -Fc backup + manifest → ops:upgrade-check gate (must say OK
 *   with exactly 0006-coaching + 0007-oracle pending, and must REFUSE when
 *   the backup is older than the RPO ceiling) → migrate → prove Phase-3
 *   data survived (canvas history intact, envelope still decrypts) and
 *   Phase-4 works (coaching session + report, ACL denies a non-shared user).
 */

const PHASE3_HEAD = "0005-ai";
const PHASE4_PENDING = ["0006-coaching", "0007-oracle"];
const CANVAS_MARKER = `rehearsal-${randomUUID().slice(0, 8)}`;
const REPORT_MARKER = `report-${randomUUID().slice(0, 8)}`;
const REHEARSAL_API_KEY = `rehearsal-key-${randomUUID().slice(0, 8)}`;

function urlPassword(url: string): string | undefined {
  const password = new URL(url).password;
  return password === "" ? undefined : decodeURIComponent(password);
}

async function login(
  app: Express,
  origin: string,
  persona: Persona,
): Promise<string | null> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Origin", origin)
    .send({ email: personaEmail(persona), password: FIXTURE_PASSWORD });
  return res.status === 200
    ? (res.body as { accessToken: string }).accessToken
    : null;
}

describe("Phase3→4 upgrade rehearsal", () => {
  it(
    "dumps a Phase-3 schema, passes upgrade-check with 0006+0007 pending, " +
      "migrates, and keeps Phase-3 data working on Phase-4",
    async () => {
      const maintenanceDb = createDb(TEST_MAINTENANCE_DATABASE_URL, {
        poolMax: 2,
      });
      await assertConnectedToDisposableDb(maintenanceDb, "gwp_test");
      const schema = `test_${randomUUID().replaceAll("-", "")}`;
      const dump = path.join(
        os.tmpdir(),
        `gwp-rehearsal-${process.pid}-${randomUUID().slice(0, 8)}.dump`,
      );
      let migratorDb: Knex | undefined;
      let appDb: Knex | undefined;
      try {
        await maintenanceDb.raw(`CREATE SCHEMA "${schema}"`);
        await maintenanceDb.raw(
          `GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "gwp_migrator"`,
        );
        await maintenanceDb.raw(
          `GRANT USAGE ON SCHEMA "${schema}" TO "gwp_runtime", "gwp_maintenance"`,
        );
        migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
          searchPath: schema,
          poolMax: 2,
        });

        // --- Phase-3 state: everything up to 0005-ai, nothing beyond ---
        await migrate(migratorDb, { mode: "demo", upTo: PHASE3_HEAD });
        const before = await migrationStatus(migratorDb);
        expect(before.applied).toEqual([
          "0001-foundation",
          "0002-organization",
          "0003-one-time-token",
          "0004-canvas",
          "0005-ai",
        ]);
        expect(before.pending).toEqual(PHASE4_PENDING);

        // Phase-3-era seed, plain SQL on the migrator credential: company +
        // personas, a published canvas version, the BYOK settings envelope.
        const personaIds = generatePersonaIds();
        const { companyId } = await seedCompanyWithPersonas(
          migratorDb,
          "Phase-3 Rehearsal Company",
          personaIds,
        );
        const canonical = JSON.parse(
          readFileSync("tests/fixtures/canvas/canonical.json", "utf8"),
        ) as { meta: { title: string }; schema_version: number };
        canonical.meta.title = CANVAS_MARKER;
        const canvasId = randomUUID();
        const versionId = randomUUID();
        await migratorDb("canvas").insert({
          id: canvasId,
          company_id: companyId,
          owner_user_id: personaIds.member,
          name: CANVAS_MARKER,
          status: "active",
          created_by: personaIds.member,
        });
        await migratorDb("canvas_version").insert({
          id: versionId,
          company_id: companyId,
          canvas_id: canvasId,
          version_no: 1,
          schema_version: canonical.schema_version,
          body: canonical,
          published_by: personaIds.member,
        });
        await migratorDb("canvas")
          .where({ id: canvasId })
          .update({ current_version_id: versionId });
        const keyEnvelope = encryptSecret(
          REHEARSAL_API_KEY,
          parseKeyRing(testEnv.APP_KEY!),
          companyId,
        );
        await migratorDb("setting").insert({
          company_id: companyId,
          key: "ai",
          value: {
            v: 1,
            enabled: true,
            baseUrl: "https://llm.internal:8443/v1",
            model: "pilot",
            timeoutSeconds: 120,
            maxOutputTokens: 4000,
            keyEnvelope,
          } satisfies Record<string, unknown>,
          updated_by: personaIds.owner,
        });

        // --- the backup an operator would take before the window ---
        dumpFixtureSchema(schema, dump);
        writeBackupManifest(dump, before.applied);

        // --- the shipped pre-upgrade gate on that backup ---
        const gate = await checkUpgrade({
          url: TEST_MAINTENANCE_DATABASE_URL,
          backup: dump,
          schema,
        });
        expect(gate.problems).toEqual([]);
        expect(gate.ok).toBe(true);
        expect(gate.pending).toEqual(PHASE4_PENDING);

        // ... and it must refuse when the only backup is older than the
        // RPO ceiling (simulate by aging the file 48h).
        const stale = new Date(Date.now() - 48 * 3_600_000);
        utimesSync(dump, stale, stale);
        const refused = await checkUpgrade({
          url: TEST_MAINTENANCE_DATABASE_URL,
          backup: dump,
          schema,
        });
        expect(refused.ok).toBe(false);
        expect(refused.problems.join(" ")).toMatch(/RPO/);
        utimesSync(dump, new Date(), new Date());

        // --- the upgrade itself ---
        await migrate(migratorDb);
        const after = await migrationStatus(migratorDb);
        expect(after.pending).toEqual([]);
        // New Phase-4 tables need grants the Phase-3 provisioning never
        // issued — re-run the shipped bootstrap, like the runbook says.
        await bootstrapDbRoles({
          adminUrl: TEST_MAINTENANCE_DATABASE_URL,
          schema,
          allowPasswords: true,
          passwords: {
            gwp_migrator: urlPassword(TEST_MIGRATOR_DATABASE_URL),
            gwp_runtime: urlPassword(TEST_DATABASE_URL),
            gwp_maintenance:
              process.env.GWP_MAINTENANCE_PASSWORD ?? "gwp_maintenance",
          },
        });

        // --- proof on the upgraded schema, through the real app ---
        appDb = createDb(TEST_DATABASE_URL, { searchPath: schema, poolMax: 3 });
        const config = loadConfig({ ...testEnv });
        const app = createApp({ db: appDb, clock: () => new Date(), config });
        const ownerToken = await login(app, config.appOrigin, "owner");
        const managerToken = await login(app, config.appOrigin, "manager");
        const memberToken = await login(app, config.appOrigin, "member");
        const outsiderToken = await login(app, config.appOrigin, "outsider");
        expect(ownerToken && managerToken && memberToken && outsiderToken)
          .toBeTruthy();
        const get = (token: string, url: string) =>
          request(app)
            .get(url)
            .set("Origin", config.appOrigin)
            .set("Authorization", `Bearer ${token}`);

        // Phase-3 data intact: the published version is listed and still
        // carries its marker; the BYOK envelope opens under the same ring.
        const versions = await get(
          ownerToken!,
          `/api/v1/canvases/${canvasId}/versions`,
        );
        expect(versions.status).toBe(200);
        const listed = (versions.body?.versions ?? versions.body ?? []) as {
          id?: string;
        }[];
        expect(listed.some((v) => v.id === versionId)).toBe(true);
        const detail = await get(
          ownerToken!,
          `/api/v1/canvases/${canvasId}/versions/${versionId}`,
        );
        expect(detail.status).toBe(200);
        expect(JSON.stringify(detail.body)).toContain(CANVAS_MARKER);
        const settingRow = await appDb("setting")
          .where({ company_id: companyId, key: "ai" })
          .select("value")
          .first();
        const restoredEnvelope = (
          settingRow?.value as { keyEnvelope?: SecretEnvelope } | undefined
        )?.keyEnvelope;
        expect(restoredEnvelope).toBeDefined();
        expect(
          decryptSecret(
            restoredEnvelope!,
            parseKeyRing(testEnv.APP_KEY!),
            companyId,
          ),
        ).toBe(REHEARSAL_API_KEY);

        // Phase-4 works: coaching session through the API, report + share
        // seeded like the drill does, then the report ACL denies the
        // non-shared user.
        const session = await request(app)
          .post("/api/v1/coaching-sessions")
          .set("Origin", config.appOrigin)
          .set("Authorization", `Bearer ${managerToken}`)
          .send({
            coachUserId: personaIds.manager,
            coacheeUserId: personaIds.member,
            occurredAt: new Date().toISOString(),
          });
        expect(session.status, JSON.stringify(session.body)).toBe(201);
        const sessionId = session.body.id as string;
        const reportId = randomUUID();
        await appDb("coaching_report").insert({
          id: reportId,
          company_id: companyId,
          session_id: sessionId,
          report_version: 1,
          rubric_version: "ORACLE-v3",
          body: { report_markdown: `# Rehearsal\n\n${REPORT_MARKER}` },
          created_by: personaIds.manager,
        });
        await appDb("report_share").insert({
          company_id: companyId,
          report_id: reportId,
          user_id: personaIds.member,
          granted_by: personaIds.manager,
        });
        const sharee = await get(memberToken!, `/api/v1/reports/${reportId}`);
        expect(sharee.status).toBe(200);
        expect(JSON.stringify(sharee.body)).toContain(REPORT_MARKER);
        const denied = await get(
          outsiderToken!,
          `/api/v1/reports/${reportId}`,
        );
        expect(denied.status).toBe(404);
      } finally {
        await appDb?.destroy().catch(() => {});
        await migratorDb?.destroy().catch(() => {});
        await maintenanceDb
          .raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
          .catch(() => {});
        await maintenanceDb.destroy().catch(() => {});
        for (const f of [dump, `${dump}.manifest.json`]) {
          try {
            unlinkSync(f);
          } catch {
            /* temp artifacts are best-effort cleanup */
          }
        }
      }
    },
    180_000,
  );
});
