import type { Knex } from "knex";
import type { CanvasRow } from "./repository.js";

/**
 * Composed read queries for the canvas module (task 2.3). repository.ts
 * owns single-table row access; this file owns the SELECTs that span
 * tables — the subject-scoped list page (owner name join + draft presence)
 * — and the keyset cursor codec it paginates on. No authorization decision
 * lives here: callers pass the already-resolved owner scope from the
 * subject policy.
 */

type Qb = Knex | Knex.Transaction;

export interface ScopedCanvasRow extends CanvasRow {
  owner_name: string;
  has_draft: boolean;
  /** created_at rendered by Postgres at full µs precision (cursor only). */
  cursor_ts: string;
}

/**
 * Keyset position of the list page: (created_at, id) descending — same
 * discipline as the audit trail. `at` is the microsecond-precision ISO
 * instant rendered by Postgres itself, so the round-trip through
 * ::timestamptz is exact and rows sharing a millisecond are never skipped.
 */
export interface CanvasCursor {
  at: string;
  id: string;
}

/** The opaque token handed back as Page.nextCursor: `<iso-µs>|<uuid>`. */
export function encodeCanvasCursor(row: ScopedCanvasRow): string {
  return `${row.cursor_ts}|${row.id}`;
}

/**
 * Display name of a company user — read for owner rendering in canvas
 * DTOs. Returns undefined for a missing/foreign id; callers degrade to an
 * empty label, never a content leak.
 */
export async function findUserDisplayName(
  db: Qb,
  companyId: string,
  userId: string,
): Promise<string | undefined> {
  const row = (await db("app_user")
    .where({ id: userId, company_id: companyId })
    .select("name")
    .first()) as { name: string } | undefined;
  return row?.name;
}

/**
 * One page of canvases owned by any subject in `ownerIds`, newest first.
 * ownerIds comes straight from policy.scopeSubjectIds — the list can never
 * outgrow the caller's subject scope. An empty scope is valid input and
 * yields an empty page (the query is skipped by the service).
 */
export async function listScopedCanvases(
  db: Qb,
  companyId: string,
  ownerIds: string[],
  opts: { limit: number; cursor?: CanvasCursor },
): Promise<ScopedCanvasRow[]> {
  let q = db("canvas")
    .join(
      "app_user",
      function () {
        this.on("app_user.id", "=", "canvas.owner_user_id").andOn(
          "app_user.company_id",
          "=",
          "canvas.company_id",
        );
      },
    )
    .where({ "canvas.company_id": companyId })
    .whereIn("canvas.owner_user_id", ownerIds)
    .orderBy([
      { column: "canvas.created_at", order: "desc" },
      { column: "canvas.id", order: "desc" },
    ])
    .limit(opts.limit + 1);
  if (opts.cursor !== undefined) {
    q = q.whereRaw(
      "(canvas.created_at, canvas.id) < (?::timestamptz, ?::uuid)",
      [opts.cursor.at, opts.cursor.id],
    );
  }
  return (await q.select([
    "canvas.id",
    "canvas.company_id",
    "canvas.owner_user_id",
    "canvas.name",
    "canvas.status",
    "canvas.current_version_id",
    "canvas.created_by",
    "canvas.created_at",
    "canvas.archived_at",
    "canvas.archived_by",
    "app_user.name as owner_name",
    db.raw(
      `EXISTS (
         SELECT 1 FROM canvas_draft d
         WHERE d.company_id = canvas.company_id
           AND d.canvas_id = canvas.id
       ) AS has_draft`,
    ),
    // Full µs precision for the cursor — JS Date/toISOString() would
    // truncate to ms and skip peer rows inside the truncated boundary.
    db.raw(
      `to_char(canvas.created_at AT TIME ZONE 'UTC', ` +
        `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`,
    ),
  ])) as ScopedCanvasRow[];
}
