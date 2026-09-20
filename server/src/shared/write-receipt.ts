import type { Knex } from "knex";
import { AppError } from "./errors.js";

/**
 * Idempotent-write receipts (task 2.4, spec §5.2). One write_receipt row per
 * (scope, key) records the id of the row a mutation produced, so a retried
 * request — client timeout, network drop, double click — replays the stored
 * result instead of applying the write a second time.
 *
 * Semantics:
 * - Same (scope, key) + same requestHash → replay: no write runs, the
 *   stored resultId is returned (replayed: true).
 * - Same (scope, key) + different requestHash → 409 IDEMPOTENCY_CONFLICT:
 *   an idempotency key never binds to two different payloads.
 * - No live receipt → `write()` runs inside the caller's transaction and
 *   the receipt is inserted in that same tx — a replay can only ever see
 *   a committed result, never a half-applied write.
 *
 * Callers MUST run inside the company write lock (lockCompany) — or an
 * equivalent serialization — so a racing same-key write either commits
 * before the lookup (seen → replay/conflict) or after it (its receipt
 * insert collides on the unique index → 409, never a duplicate effect).
 *
 * Retention: receipts are consultable for 7 days (RECEIPT_RETENTION). An
 * expired row is treated as absent and its (scope, key) slot is reclaimed
 * inside the transaction; table growth beyond that is a janitor concern —
 * `DELETE FROM write_receipt WHERE created_at < now() - interval '7 days'`
 * — not a correctness requirement.
 */
export const RECEIPT_RETENTION = "7 days";

export interface ReceiptResult {
  /** Id of the row the write produced — fresh or replayed from storage. */
  resultId: string;
  /** True when an existing receipt answered — `write` did not run. */
  replayed: boolean;
}

interface WriteReceiptRow {
  id: string;
  request_hash: string;
  result_id: string;
}

function conflict(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_CONFLICT",
    "Khóa idempotency đã được dùng với một yêu cầu khác",
  );
}

export async function withReceipt(
  tx: Knex.Transaction,
  scope: string,
  key: string,
  requestHash: string,
  write: () => Promise<string>,
): Promise<ReceiptResult> {
  const existing = (await tx("write_receipt")
    .where({ scope, key })
    .whereRaw(`created_at > now() - interval '${RECEIPT_RETENTION}'`)
    .first()) as WriteReceiptRow | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) throw conflict();
    return { resultId: existing.result_id, replayed: true };
  }

  // A receipt past its retention window counts as absent; delete the stale
  // row inside this tx so the fresh insert below can take the (scope, key)
  // slot without tripping the unique index.
  await tx("write_receipt")
    .where({ scope, key })
    .whereRaw(`created_at <= now() - interval '${RECEIPT_RETENTION}'`)
    .delete();

  const resultId = await write();
  try {
    await tx("write_receipt").insert({
      scope,
      key,
      request_hash: requestHash,
      result_id: resultId,
    });
  } catch (err) {
    // Unreachable while callers hold the company lock — a concurrent
    // same-key insert means two writers raced outside it. The other tx's
    // receipt wins on commit; this write must not apply twice → 409 and
    // the whole transaction rolls back.
    if ((err as { code?: string }).code === "23505") throw conflict();
    throw err;
  }
  return { resultId, replayed: false };
}
