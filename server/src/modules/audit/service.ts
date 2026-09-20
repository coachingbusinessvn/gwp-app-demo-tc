import type { Knex } from "knex";
import type { ActorContext, Page } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { loadActorRoles } from "../authorization/repository.js";

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

/* ---------- Metadata-only read path (task 1.5, spec §4/§9) ---------- */

/**
 * The audit viewer contract: owner/admin may list operational metadata —
 * NEVER raw rows and never content. The DTO carries only the fixed column
 * set below, and `metadata` is re-sanitized through the same allowlist on
 * READ (defense in depth: a row written before a key left the allowlist,
 * or inserted out-of-band, still serializes clean).
 */
export interface AuditEventDto {
  id: string;
  at: string;
  actorId: string | null;
  action: string;
  outcome: string;
  requestId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, AuditMetadataValue>;
}

interface AuditEventRow {
  id: string;
  created_at: Date | string;
  actor_id: string | null;
  action: string;
  outcome: string;
  request_id: string | null;
  target_type: string | null;
  target_id: string | null;
  safe_metadata: Record<string, unknown> | null;
}

/** Keyset cursor position: (created_at, id) — descending order. */
export interface AuditCursor {
  at: Date;
  id: string;
}

/** The cursor token handed back as Page.nextCursor: `<iso>|<uuid>`. */
export function encodeAuditCursor(row: AuditEventRow): string {
  return `${new Date(row.created_at).toISOString()}|${row.id}`;
}

function toAuditEventDto(row: AuditEventRow): AuditEventDto {
  return {
    id: row.id,
    at: new Date(row.created_at).toISOString(),
    actorId: row.actor_id,
    action: row.action,
    outcome: row.outcome,
    requestId: row.request_id,
    targetType: row.target_type,
    targetId: row.target_id,
    // Re-sanitize on read: keys outside AUDIT_METADATA_ALLOWLIST and
    // non-scalar/oversized values are dropped even if they exist on disk.
    metadata: sanitizeAuditMetadata(row.safe_metadata ?? {}),
  };
}

const AUDIT_EVENT_COLUMNS = [
  "id",
  "created_at",
  "actor_id",
  "action",
  "outcome",
  "request_id",
  "target_type",
  "target_id",
  "safe_metadata",
] as const;

/**
 * Owner/admin only (spec §4: "Xem audit quản trị"). Roles are re-read
 * from the DB per request — never the JWT. Newest-first keyset over
 * (created_at, id): the cursor is the composite position of the last row
 * of the previous page, so no row is skipped or repeated.
 */
export async function listAuditEvents(
  db: Knex,
  actor: ActorContext,
  opts: { limit: number; cursor?: AuditCursor },
): Promise<Page<AuditEventDto>> {
  const roles = await loadActorRoles(db, actor.companyId, actor.userId);
  if (!roles.includes("owner") && !roles.includes("admin")) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Chỉ owner hoặc admin được xem nhật ký kiểm toán",
    );
  }
  let q = db("audit_event")
    .where({ company_id: actor.companyId })
    .orderBy([
      { column: "created_at", order: "desc" },
      { column: "id", order: "desc" },
    ])
    .limit(opts.limit + 1);
  if (opts.cursor !== undefined) {
    q = q.whereRaw("(created_at, id) < (?::timestamptz, ?::uuid)", [
      opts.cursor.at.toISOString(),
      opts.cursor.id,
    ]);
  }
  const rows = (await q.select(AUDIT_EVENT_COLUMNS)) as AuditEventRow[];
  const items = rows.slice(0, opts.limit);
  return {
    items: items.map(toAuditEventDto),
    nextCursor:
      rows.length > opts.limit
        ? encodeAuditCursor(items[items.length - 1])
        : null,
  };
}
