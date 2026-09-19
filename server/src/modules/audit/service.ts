import type { Knex } from "knex";

/**
 * Append-only audit writer (spec §9). Rows are inserted inside the caller's
 * transaction so the audit record commits or rolls back with the business
 * operation it describes. There is deliberately no update/delete path here,
 * and the runtime DB role holds only INSERT/SELECT on audit_event — enforced
 * by grants, not convention.
 *
 * safe_metadata policy: a strict key allowlist below, and only scalar values
 * (string ≤ 200 chars, finite number, boolean, null) survive. Anything else —
 * unknown keys, objects, arrays, overlong strings — is STRIPPED, not rejected:
 * an over-eager caller must never break the audited operation, and the
 * allowlist is the boundary that keeps secrets, tokens and user content out
 * of the audit trail. Extend the set only with keys that can never carry
 * secret or content payloads.
 */
export const AUDIT_METADATA_ALLOWLIST: ReadonlySet<string> = new Set([
  "assistant", // which AI assistant acted (renderer|coach|grader)
  "count", // counts only, e.g. rows exported
  "error_code", // stable machine code on failure outcomes
  "field", // name of a changed field — never its value
  "key", // setting/config key name — never its value
  "key_version", // secret key version for crypto operations
  "mode", // deployment mode relevant to the event
  "model", // model identifier string
  "reason", // short reason code, e.g. "reused_refresh_token"
  "result", // coarse result label
  "role", // role key granted/revoked
  "status", // resulting status string
  "version", // version number (canvas/report/rubric/prompt)
]);

const MAX_METADATA_VALUE_LENGTH = 200;

export type AuditMetadataValue = string | number | boolean | null;

export interface AuditEventInput {
  companyId: string;
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome: string;
  requestId: string;
  metadata: Record<string, unknown>;
}

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, AuditMetadataValue> {
  const safe: Record<string, AuditMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!AUDIT_METADATA_ALLOWLIST.has(key)) continue;
    if (value === null) {
      safe[key] = null;
    } else if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
    } else if (
      typeof value === "string" &&
      value.length <= MAX_METADATA_VALUE_LENGTH
    ) {
      safe[key] = value;
    }
    // Non-allowlisted keys and non-scalar/oversized values are dropped.
  }
  return safe;
}

export async function appendAudit(
  tx: Knex.Transaction,
  event: AuditEventInput,
): Promise<void> {
  await tx("audit_event").insert({
    company_id: event.companyId,
    actor_id: event.actorId ?? null,
    action: event.action,
    target_type: event.targetType ?? null,
    target_id: event.targetId ?? null,
    outcome: event.outcome,
    safe_metadata: sanitizeAuditMetadata(event.metadata),
    request_id: event.requestId,
  });
}
