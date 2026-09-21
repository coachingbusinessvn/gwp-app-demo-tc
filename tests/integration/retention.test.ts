import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runRetention } from "../../server/src/jobs/retention.js";
import { rotateEnvelopes } from "../../scripts/ops/rotate-key.js";
import { createDb } from "../../server/src/db/connection.js";
import {
  decryptSecret,
  parseKeyRing,
} from "../../server/src/security/secrets.js";
import { fixture, type Fixture } from "../helpers/fixture.js";

/**
 * Task 4.5 — retention, key rotation and ops security (spec §9).
 *
 * Contracts under test:
 * - Retention runs under the gwp_maintenance credential only — the
 *   runtime role cannot delete audit rows (append-only), and maintenance
 *   cannot delete business tables it was never granted (coaching_report).
 * - Expired-only deletion with per-company owner-configurable floors:
 *   audit 365d / ai_run 90d (terminal only) / write_receipt 7d; owner
 *   settings may INCREASE the floor, never decrease it.
 * - ai_run purge preserves coaching_report rows: the composite FK nulls
 *   ai_run_id and the immutable provenance copy survives untouched.
 * - report_share has no time-based expiry — only explicit revoke removes
 *   a grant; a retention sweep must not touch it.
 * - Dead-token cleanup removes refresh/one-time tokens only after the
 *   revocation horizon — reuse detection stays live while the family is.
 * - rotate-key rewrites every stored BYOK envelope transactionally after
 *   validating each decrypts; no plaintext or key material is emitted.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Dead tokens outlive their family by this horizon (forensics window). */
const HORIZON = 7 * DAY;

const NOW = new Date("2027-09-21T00:00:00.000Z");
const OLD = new Date(NOW.getTime() - 400 * DAY); // beyond every default
const MID = new Date(NOW.getTime() - 100 * DAY); // beyond AI 90d only
const RECENT = new Date(NOW.getTime() - 1 * DAY);

const MAINTENANCE_URL =
  process.env.TEST_MAINTENANCE_ROLE_URL ??
  "postgres://gwp_maintenance:gwp_maintenance@127.0.0.1:54329/gwp_test";

async function currentSchema(f: Fixture): Promise<string> {
  const r = await f.db.raw("select current_schema() as s");
  return (r.rows[0] as { s: string }).s;
}

describe("retention job (task 4.5)", () => {
  it("purges expired rows under maintenance, preserves protected data, and honours owner-increased floors", async () => {
    const f = await fixture({ seeded: true });
    try {
      const schema = await currentSchema(f);
      const m = f.maintenanceDb;
      const co = f.ids.company;
      const T = (t: string) => `${schema}.${t}`;

      /* ---------- seed aged rows (superuser setup only) ---------- */
      const auditOld = randomUUID();
      const auditFresh = randomUUID();
      await m(T("audit_event")).insert([
        {
          id: auditOld,
          company_id: co,
          actor_id: f.ids.manager,
          action: "auth.login",
          outcome: "success",
          created_at: OLD,
        },
        {
          id: auditFresh,
          company_id: co,
          actor_id: f.ids.manager,
          action: "auth.login",
          outcome: "success",
          created_at: RECENT,
        },
      ]);

      // The session first — oracle-shaped ai_run rows reference it
      // (ai_run_target_check requires session_id for the oracle shape).
      const sessionId = randomUUID();
      await m(T("coaching_session")).insert({
        id: sessionId,
        company_id: co,
        coach_user_id: f.ids.manager,
        coachee_user_id: f.ids.member,
        occurred_at: OLD,
        created_by: f.ids.manager,
        created_at: OLD,
      });

      // AI runs: old+terminal (purge), old+queued (keep — not terminal),
      // fresh terminal (keep — inside window).
      const runOld = randomUUID();
      const runQueued = randomUUID();
      const runFresh = randomUUID();
      await m(T("ai_run")).insert([
        {
          id: runOld,
          company_id: co,
          actor_id: f.ids.manager,
          assistant: "oracle",
          session_id: sessionId,
          status: "succeeded",
          idempotency_key: `old-${randomUUID()}`,
          input_hash: "h1",
          consent_at: OLD,
          created_at: OLD,
          finished_at: OLD,
        },
        {
          id: runQueued,
          company_id: co,
          actor_id: f.ids.manager,
          assistant: "oracle",
          session_id: sessionId,
          status: "queued",
          idempotency_key: `queued-${randomUUID()}`,
          input_hash: "h2",
          consent_at: OLD,
          created_at: OLD,
        },
        {
          id: runFresh,
          company_id: co,
          actor_id: f.ids.manager,
          assistant: "oracle",
          session_id: sessionId,
          status: "succeeded",
          idempotency_key: `fresh-${randomUUID()}`,
          input_hash: "h3",
          consent_at: RECENT,
          created_at: RECENT,
          finished_at: RECENT,
        },
      ]);

      // A saved report pointing at the old run — the FK must null the
      // reference while the report body/provenance survive.
      const reportId = randomUUID();
      const provenance = { model: "pilot", key_version: "v1" };
      await m(T("coaching_report")).insert({
        id: reportId,
        company_id: co,
        session_id: sessionId,
        ai_run_id: runOld,
        report_version: 1,
        rubric_version: "ORACLE-v3",
        body: { markdown: "# report" },
        provenance,
        created_by: f.ids.manager,
        created_at: OLD,
      });
      // An active share on the report — retention never expires shares.
      await m(T("report_share")).insert({
        company_id: co,
        report_id: reportId,
        user_id: f.ids.member,
        granted_by: f.ids.manager,
        granted_at: OLD,
      });

      // Receipts: expired (>7d) vs live.
      const receiptOld = randomUUID();
      const receiptFresh = randomUUID();
      await m(T("write_receipt")).insert([
        {
          id: receiptOld,
          scope: "report",
          key: `k-${randomUUID()}`,
          request_hash: "x",
          result_id: reportId,
          created_at: new Date(NOW.getTime() - 10 * DAY),
        },
        {
          id: receiptFresh,
          scope: "report",
          key: `k-${randomUUID()}`,
          request_hash: "x",
          result_id: reportId,
          created_at: RECENT,
        },
      ]);

      // Dead session (expired past the horizon) with a consumed token →
      // purge. Live session's consumed token stays — reuse detection.
      const deadSession = randomUUID();
      const liveSession = randomUUID();
      await m(T("auth_session")).insert([
        {
          id: deadSession,
          company_id: co,
          user_id: f.ids.member,
          token_family_id: randomUUID(),
          expires_at: new Date(NOW.getTime() - 30 * DAY),
          created_at: new Date(NOW.getTime() - 40 * DAY),
        },
        {
          id: liveSession,
          company_id: co,
          user_id: f.ids.member,
          token_family_id: randomUUID(),
          expires_at: new Date(NOW.getTime() + 5 * DAY),
          created_at: RECENT,
        },
      ]);
      const deadToken = randomUUID();
      const liveToken = randomUUID();
      await m(T("refresh_token")).insert([
        {
          id: deadToken,
          session_id: deadSession,
          token_hash: `dead-${randomUUID()}`,
          expires_at: new Date(NOW.getTime() - 30 * DAY),
          consumed_at: new Date(NOW.getTime() - 30 * DAY),
        },
        {
          id: liveToken,
          session_id: liveSession,
          token_hash: `live-${randomUUID()}`,
          expires_at: new Date(NOW.getTime() + 5 * DAY),
          consumed_at: RECENT,
        },
      ]);

      // One-time tokens: used+expired past horizon → purge; live → keep.
      const ottDead = randomUUID();
      const ottLive = randomUUID();
      await m(T("one_time_token")).insert([
        {
          id: ottDead,
          company_id: co,
          user_id: f.ids.member,
          token_hash: `ott-dead-${randomUUID()}`,
          purpose: "reset",
          expires_at: new Date(NOW.getTime() - 30 * DAY),
          used_at: new Date(NOW.getTime() - 30 * DAY),
          created_by: f.ids.owner,
          created_at: new Date(NOW.getTime() - 40 * DAY),
        },
        {
          id: ottLive,
          company_id: co,
          user_id: f.ids.member,
          token_hash: `ott-live-${randomUUID()}`,
          purpose: "reset",
          expires_at: new Date(NOW.getTime() + DAY),
          created_by: f.ids.owner,
          created_at: RECENT,
        },
      ]);

      /* ---------- owner may raise the floor; audit 500d keeps OLD ---------- */
      const raised = await f
        .api("owner")
        .patch("/api/v1/settings/retention")
        .send({ auditDays: 500, aiRunDays: 90, logDays: 30, receiptDays: 7 });
      expect(raised.status).toBe(200);

      const maintDb = createDb(MAINTENANCE_URL, { searchPath: schema });
      try {
        const first = await runRetention(maintDb, NOW);
        expect(first).toMatchObject({
          auditDeleted: 0, // owner raised the floor — 400d < 500d survives
          aiDeleted: 1, // only the old terminal run
          receiptsDeleted: 1,
        });
        expect(
          await m(T("audit_event")).where({ id: auditOld }).first(),
        ).toBeTruthy();

        // Lower the floor back to default → the old audit row goes.
        const lowered = await f
          .api("owner")
          .patch("/api/v1/settings/retention")
          .send({
            auditDays: 365,
            aiRunDays: 90,
            logDays: 30,
            receiptDays: 7,
          });
        expect(lowered.status).toBe(200);
        const second = await runRetention(maintDb, NOW);
        expect(second.auditDeleted).toBe(1);
      } finally {
        await maintDb.destroy().catch(() => {});
      }

      /* ---------- survivors and preserved references ---------- */
      expect(
        await m(T("audit_event")).where({ id: auditFresh }).first(),
      ).toBeTruthy();
      expect(
        await m(T("ai_run")).where({ id: runOld }).first(),
      ).toBeUndefined();
      expect(
        await m(T("ai_run")).where({ id: runQueued }).first(),
      ).toBeTruthy(); // non-terminal never purged
      expect(
        await m(T("ai_run")).where({ id: runFresh }).first(),
      ).toBeTruthy();

      const report = await m(T("coaching_report"))
        .where({ id: reportId })
        .first();
      expect(report.ai_run_id).toBeNull();
      expect(report.provenance).toEqual(provenance);
      expect(
        await m(T("report_share"))
          .where({ report_id: reportId, user_id: f.ids.member })
          .first(),
      ).toBeTruthy(); // shares expire only by explicit revoke

      expect(
        await m(T("write_receipt")).where({ id: receiptOld }).first(),
      ).toBeUndefined();
      expect(
        await m(T("write_receipt")).where({ id: receiptFresh }).first(),
      ).toBeTruthy();

      expect(
        await m(T("refresh_token")).where({ id: deadToken }).first(),
      ).toBeUndefined();
      expect(
        await m(T("refresh_token")).where({ id: liveToken }).first(),
      ).toBeTruthy();
      expect(
        await m(T("one_time_token")).where({ id: ottDead }).first(),
      ).toBeUndefined();
      expect(
        await m(T("one_time_token")).where({ id: ottLive }).first(),
      ).toBeTruthy();

      /* ---------- credential boundaries ---------- */
      // Runtime role: audit is append-only — no delete path in the app.
      await expect(
        f.db("audit_event").where({ id: auditFresh }).delete(),
      ).rejects.toMatchObject({ code: "42501" });
      // Maintenance role: business tables stay read-only for it too —
      // retention deletes only the retention-managed tables.
      const maintDb2 = createDb(MAINTENANCE_URL, { searchPath: schema });
      try {
        await expect(
          maintDb2("coaching_report").where({ id: reportId }).delete(),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await maintDb2.destroy().catch(() => {});
      }
    } finally {
      await f.close();
    }
  });

  it("retention settings reject decreases and non-owners", async () => {
    const f = await fixture({ seeded: true });
    try {
      const got = await f.api("owner").get("/api/v1/settings/retention");
      expect(got.status).toBe(200);
      expect(got.body).toMatchObject({
        auditDays: 365,
        aiRunDays: 90,
        logDays: 30,
        receiptDays: 7,
      });

      // Floors are one-directional: lower values are rejected, higher kept.
      const tooLow = await f
        .api("owner")
        .patch("/api/v1/settings/retention")
        .send({ auditDays: 100, aiRunDays: 90, logDays: 30, receiptDays: 7 });
      expect(tooLow.status).toBe(400);

      const asMember = await f
        .api("member")
        .patch("/api/v1/settings/retention")
        .send({
          auditDays: 500,
          aiRunDays: 90,
          logDays: 30,
          receiptDays: 7,
        });
      expect(asMember.status).toBe(403);
      // Admin is not owner — the retention floor is the owner's call (§9).
      const asAdmin = await f
        .api("admin")
        .patch("/api/v1/settings/retention")
        .send({
          auditDays: 500,
          aiRunDays: 90,
          logDays: 30,
          receiptDays: 7,
        });
      expect(asAdmin.status).toBe(403);
    } finally {
      await f.close();
    }
  });

  it("rotate-key rewrites every envelope transactionally and never emits material", async () => {
    const f = await fixture({ seeded: true });
    try {
      const schema = await currentSchema(f);
      const m = f.maintenanceDb;
      const T = (t: string) => `${schema}.${t}`;

      // Real encrypted key through the API — stored as a v1 envelope.
      const secret = "byok-test-key-material-0123456789abcdef";
      const saved = await f.api("owner").put("/api/v1/settings/ai").send({
        enabled: true,
        baseUrl: "https://llm.internal:8443/v1",
        apiKey: secret,
        model: "pilot",
      });
      expect(saved.status).toBe(200);
      expect(saved.body.keyVersion).toBe("v1");

      const oldRing = parseKeyRing("test-app-key-0123456789abcdef0123456789");
      const newRingEntry = {
        version: "v2",
        material: "rotated-app-key-0123456789abcdef0123456789",
      };
      const res = await rotateEnvelopes(m, {
        schema,
        ring: oldRing,
        toVersion: newRingEntry.version,
        toMaterial: newRingEntry.material,
      });
      expect(res.rotated).toBe(1);

      const row = await m(T("setting"))
        .where({ company_id: f.ids.company, key: "ai" })
        .first();
      const envelope = (row.value as { keyEnvelope: unknown })
        .keyEnvelope as Parameters<typeof decryptSecret>[0];
      expect(envelope.keyVersion).toBe("v2");

      // New ring (v2 + retained v1) opens it; a v1-only ring cannot —
      // that is exactly why the runbook keeps the old version until the
      // backup window expires.
      const merged = parseKeyRing(
        `v2=${newRingEntry.material},v1=test-app-key-0123456789abcdef0123456789`,
      );
      expect(decryptSecret(envelope, merged, f.ids.company)).toBe(secret);
      expect(() =>
        decryptSecret(envelope, oldRing, f.ids.company),
      ).toThrowError(/không còn phiên bản/i);
    } finally {
      await f.close();
    }
  });

  it("rotate-key validates every envelope before commit — a corrupt row aborts all", async () => {
    const f = await fixture({ seeded: true });
    try {
      const schema = await currentSchema(f);
      const m = f.maintenanceDb;
      const T = (t: string) => `${schema}.${t}`;

      const secret = "byok-test-key-material-0123456789abcdef";
      await f.api("owner").put("/api/v1/settings/ai").send({
        enabled: true,
        baseUrl: "https://llm.internal:8443/v1",
        apiKey: secret,
        model: "pilot",
      });

      // A second envelope-shaped setting row (e.g. a stashed backup) with
      // a deliberately broken envelope — rotation must fail on it BEFORE
      // committing any rewrite of the good row.
      const badEnvelope = {
        v: 1,
        enabled: true,
        baseUrl: "https://llm.internal:8443/v1",
        model: "pilot",
        timeoutSeconds: 30,
        maxOutputTokens: 512,
        keyEnvelope: {
          ciphertext: "AAAA",
          iv: "AAAAAAAAAAAAAAAA",
          tag: "AAAAAAAAAAAAAAAAAAAAAA==",
          keyVersion: "v1",
        },
      };
      await m(T("setting")).insert({
        company_id: f.ids.company,
        key: "ai-backup",
        value: badEnvelope,
        updated_by: f.ids.owner,
        updated_at: NOW,
      });

      const oldRing = parseKeyRing("test-app-key-0123456789abcdef0123456789");
      await expect(
        rotateEnvelopes(m, {
          schema,
          ring: oldRing,
          toVersion: "v2",
          toMaterial: "rotated-app-key-0123456789abcdef0123456789",
        }),
      ).rejects.toThrowError();

      // Aborted — the valid row must still be v1 (no partial switch).
      const row = await m(T("setting"))
        .where({ company_id: f.ids.company, key: "ai" })
        .first();
      expect(
        (row.value as { keyEnvelope: { keyVersion: string } }).keyEnvelope
          .keyVersion,
      ).toBe("v1");
    } finally {
      await f.close();
    }
  });
});
