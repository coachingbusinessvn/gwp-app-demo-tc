import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";
import { createDb } from "../db/connection.js";

/**
 * Retention job (task 4.5, spec §9) — the ONLY delete path for expired
 * operational data. Runs as the gwp_maintenance credential (SELECT +
 * scoped DELETE grants — no runtime API, no superuser) from a one-shot
 * job container, on the operator's schedule.
 *
 * Floors (spec §9): audit 365d, AI metadata 90d, operational logs 30d,
 * receipts 7d. An owner's `retention` setting may RAISE a floor, never
 * lower it — the effective cutoff is max(default, configured), per
 * company for company-scoped tables and globally for shared ones.
 *
 * What it never touches:
 * - non-terminal ai_run rows (queued/running — only terminal states age
 *   out); the coaching_report FK is ON DELETE SET NULL so purged runs
 *   leave the report + its immutable provenance copy intact;
 * - report_share — grants expire ONLY by explicit revoke, never by age;
 * - refresh/one-time tokens whose family is still inside the revocation
 *   horizon — a consumed token must stay detectable while its session
 *   could still be presented (reuse detection, spec §8).
 *
 * Every delete is a bounded batch under pg_advisory_xact_lock so two
 * overlapping runs serialize instead of doubling the work; a second run
 * simply finds nothing to do.
 */

export const RETENTION_FLOORS = {
  auditDays: 365,
  aiRunDays: 90,
  logDays: 30,
  receiptDays: 7,
} as const;

/** Dead tokens outlive their family by this forensic window (spec §8/§9). */
const TOKEN_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 1000;
/** Stable advisory-lock key for the retention job (arbitrary constant). */
const LOCK_KEY = 725_001;

export interface RetentionResult {
  auditDeleted: number;
  aiDeleted: number;
  receiptsDeleted: number;
  refreshTokensDeleted: number;
  oneTimeTokensDeleted: number;
}

interface RetentionSetting {
  auditDays?: number;
  aiRunDays?: number;
  receiptDays?: number;
}

const TERMINAL_RUN_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

function dayCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/** Owner floors can only ever raise the shipped defaults (spec §9). */
function floor(stored: unknown): Required<RetentionSetting> {
  const s =
    stored && typeof stored === "object"
      ? (stored as RetentionSetting)
      : {};
  const pick = (v: number | undefined, min: number) =>
    typeof v === "number" && Number.isFinite(v) && v > min ? v : min;
  return {
    auditDays: pick(s.auditDays, RETENTION_FLOORS.auditDays),
    aiRunDays: pick(s.aiRunDays, RETENTION_FLOORS.aiRunDays),
    receiptDays: pick(s.receiptDays, RETENTION_FLOORS.receiptDays),
  };
}

/**
 * One bounded batch under a transaction-scoped advisory lock: concurrent
 * runs serialize per batch (the loser waits, then sees nothing to do),
 * and no partial batch escapes its transaction.
 */
async function deleteBatch(
  db: Knex,
  deleteSql: string,
  params: (string | Date)[],
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    const res = await tx.raw(deleteSql, params);
    return Number(res.rowCount ?? 0);
  });
}

export async function runRetention(
  db: Knex,
  now: Date = new Date(),
): Promise<RetentionResult> {
  // Per-company floors — companies without a setting row get defaults.
  const settingRows = (await db("setting")
    .where({ key: "retention" })
    .select("company_id", "value")) as {
    company_id: string;
    value: unknown;
  }[];
  const floors = new Map(
    settingRows.map((r) => [r.company_id, floor(r.value)]),
  );
  const companies = (await db("company").select("id")) as { id: string }[];

  const result: RetentionResult = {
    auditDeleted: 0,
    aiDeleted: 0,
    receiptsDeleted: 0,
    refreshTokensDeleted: 0,
    oneTimeTokensDeleted: 0,
  };

  /* ---- audit_event: per-company floor, default 365d ---- */
  for (const { id: companyId } of companies) {
    const cutoff = dayCutoff(
      now,
      floors.get(companyId)?.auditDays ?? RETENTION_FLOORS.auditDays,
    );
    for (;;) {
      const n = await deleteBatch(
        db,
        `DELETE FROM audit_event WHERE id IN (
           SELECT id FROM audit_event
           WHERE company_id = ? AND created_at < ?
           ORDER BY created_at LIMIT ${BATCH})`,
        [companyId, cutoff],
      );
      result.auditDeleted += n;
      if (n < BATCH) break;
    }
  }

  /* ---- ai_run: per-company floor, default 90d, terminal only ---- */
  for (const { id: companyId } of companies) {
    const cutoff = dayCutoff(
      now,
      floors.get(companyId)?.aiRunDays ?? RETENTION_FLOORS.aiRunDays,
    );
    for (;;) {
      const n = await deleteBatch(
        db,
        `DELETE FROM ai_run WHERE id IN (
           SELECT id FROM ai_run
           WHERE company_id = ? AND created_at < ?
             AND status IN (${TERMINAL_RUN_STATES.map(() => "?").join(",")})
           ORDER BY created_at LIMIT ${BATCH})`,
        [companyId, cutoff, ...TERMINAL_RUN_STATES],
      );
      result.aiDeleted += n;
      if (n < BATCH) break;
    }
  }

  /* ---- write_receipt: global table — the STRICTEST configured floor ---- */
  const receiptDays = [
    RETENTION_FLOORS.receiptDays,
    ...[...floors.values()].map((f) => f.receiptDays),
  ].reduce((a, b) => Math.max(a, b));
  const receiptCutoff = dayCutoff(now, receiptDays);
  for (;;) {
    const n = await deleteBatch(
      db,
      `DELETE FROM write_receipt WHERE id IN (
         SELECT id FROM write_receipt WHERE created_at < ?
         ORDER BY created_at LIMIT ${BATCH})`,
      [receiptCutoff],
    );
    result.receiptsDeleted += n;
    if (n < BATCH) break;
  }

  /* ---- dead-token cleanup — only after the revocation horizon ----
     A token whose session is still live must stay: presenting a consumed
     token is what triggers family revocation (reuse detection). Once the
     session is dead (revoked OR expired) AND the horizon has passed, the
     family can no longer be presented at all, so the tokens can go. */
  const horizonCutoff = new Date(now.getTime() - TOKEN_HORIZON_MS);
  for (;;) {
    const n = await deleteBatch(
      db,
      `DELETE FROM refresh_token WHERE id IN (
         SELECT rt.id FROM refresh_token rt
         JOIN auth_session s ON s.id = rt.session_id
         WHERE LEAST(COALESCE(s.revoked_at, 'infinity'::timestamptz),
                     s.expires_at) < ?
         LIMIT ${BATCH})`,
      [horizonCutoff],
    );
    result.refreshTokensDeleted += n;
    if (n < BATCH) break;
  }
  for (;;) {
    const n = await deleteBatch(
      db,
      `DELETE FROM one_time_token WHERE id IN (
         SELECT id FROM one_time_token WHERE expires_at < ?
         LIMIT ${BATCH})`,
      [horizonCutoff],
    );
    result.oneTimeTokensDeleted += n;
    if (n < BATCH) break;
  }

  return result;
}

/* ---------------- CLI entry ----------------
 * `node dist/server/src/jobs/retention.js` — one-shot sweep intended for a
 * scheduled `docker compose run` (see docs/operations/security-retention.md).
 * Uses the maintenance credential only; prints counts, never row content.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const url = process.env.MAINTENANCE_DATABASE_URL;
  if (!url) {
    console.error("retention: MAINTENANCE_DATABASE_URL is required");
    process.exit(1);
  }
  const db = createDb(url, { poolMax: 2 });
  try {
    const r = await runRetention(db);
    console.log(
      `retention: audit=${r.auditDeleted} ai_run=${r.aiDeleted} ` +
        `receipts=${r.receiptsDeleted} refresh_tokens=${r.refreshTokensDeleted} ` +
        `one_time_tokens=${r.oneTimeTokensDeleted}`,
    );
  } catch (err) {
    console.error(
      "retention failed:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  } finally {
    await db.destroy().catch(() => {});
  }
}
