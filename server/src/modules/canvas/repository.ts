import type { Knex } from "knex";
import type { CanvasBody } from "../../../../shared/canvas/schema.js";

/**
 * Canvas module row access — thin typed wrappers over Knex (task 2.3). No
 * business rules live here: the service owns authorization, archive and
 * transaction decisions. Every query is scoped by company_id so a row
 * outside the actor's company is invisible, matching the org module's
 * discipline. Composed read queries (scoped list page, detail assembly)
 * live in queries.ts.
 */

export interface CanvasRow {
  id: string;
  company_id: string;
  owner_user_id: string;
  name: string;
  status: string;
  current_version_id: string | null;
  created_by: string;
  created_at: Date | string;
  archived_at: Date | string | null;
  archived_by: string | null;
}

export interface CanvasDraftRow {
  id: string;
  company_id: string;
  canvas_id: string;
  base_version_id: string | null;
  revision: number;
  schema_version: number;
  body: CanvasBody;
  source: string;
  created_by: string;
  created_at: Date | string;
  updated_by: string;
  updated_at: Date | string;
}

export interface CanvasVersionRow {
  id: string;
  company_id: string;
  canvas_id: string;
  version_no: number;
  schema_version: number;
  body: CanvasBody;
  change_summary: string | null;
  provenance: Record<string, unknown> | null;
  published_by: string;
  published_at: Date | string;
}

type Qb = Knex | Knex.Transaction;

export async function findCanvasById(
  db: Qb,
  companyId: string,
  id: string,
): Promise<CanvasRow | undefined> {
  return (await db("canvas")
    .where({ id, company_id: companyId })
    .first()) as CanvasRow | undefined;
}

/**
 * The canvas row FOR UPDATE — the per-canvas serialization point every
 * protected write takes after lockCompany (task 2.4): draft saves, publish,
 * restore, archive and transfer all serialize on this row inside the tx.
 */
export async function lockCanvasById(
  tx: Knex.Transaction,
  companyId: string,
  id: string,
): Promise<CanvasRow | undefined> {
  return (await tx("canvas")
    .where({ id, company_id: companyId })
    .forUpdate()
    .first()) as CanvasRow | undefined;
}

export async function insertCanvas(
  tx: Knex.Transaction,
  row: {
    company_id: string;
    owner_user_id: string;
    name: string;
    created_by: string;
  },
): Promise<CanvasRow> {
  const rows = (await tx("canvas").insert(row, [
    "id",
    "company_id",
    "owner_user_id",
    "name",
    "status",
    "current_version_id",
    "created_by",
    "created_at",
    "archived_at",
    "archived_by",
  ])) as CanvasRow[];
  return rows[0];
}

/** The single shared draft of a canvas — UNIQUE(canvas_id) guarantees ≤1. */
export async function findDraftByCanvas(
  db: Qb,
  companyId: string,
  canvasId: string,
): Promise<CanvasDraftRow | undefined> {
  return (await db("canvas_draft")
    .where({ canvas_id: canvasId, company_id: companyId })
    .first()) as CanvasDraftRow | undefined;
}

export async function insertDraft(
  tx: Knex.Transaction,
  row: {
    company_id: string;
    canvas_id: string;
    base_version_id: string | null;
    revision: number;
    schema_version: number;
    body: CanvasBody;
    source: "manual" | "import" | "ai";
    created_by: string;
    updated_by: string;
  },
): Promise<CanvasDraftRow> {
  const rows = (await tx("canvas_draft").insert(
    { ...row, body: JSON.stringify(row.body) },
    [
      "id",
      "company_id",
      "canvas_id",
      "base_version_id",
      "revision",
      "schema_version",
      "body",
      "source",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at",
    ],
  )) as unknown as CanvasDraftRow[];
  return rows[0];
}

/**
 * CAS save (task 2.4): UPDATE … WHERE revision = expected — the optimistic-
 * concurrency predicate. Zero rows means the draft moved (or is gone);
 * the service turns that into 409 DRAFT_CONFLICT / 404. Under the company
 * lock this can only lose to a genuinely stale expectedRevision.
 */
export async function updateDraftCas(
  tx: Knex.Transaction,
  companyId: string,
  canvasId: string,
  expectedRevision: number,
  patch: {
    body: CanvasBody;
    base_version_id?: string | null;
    schema_version?: number;
    source?: "manual" | "import" | "ai";
    updated_by: string;
  },
): Promise<CanvasDraftRow | undefined> {
  const set: Record<string, unknown> = {
    body: JSON.stringify(patch.body),
    updated_by: patch.updated_by,
    updated_at: tx.fn.now(),
    revision: expectedRevision + 1,
  };
  if (patch.base_version_id !== undefined)
    set.base_version_id = patch.base_version_id;
  if (patch.schema_version !== undefined)
    set.schema_version = patch.schema_version;
  if (patch.source !== undefined) set.source = patch.source;
  const rows = (await tx("canvas_draft")
    .where({
      company_id: companyId,
      canvas_id: canvasId,
      revision: expectedRevision,
    })
    .update(set, [
      "id",
      "company_id",
      "canvas_id",
      "base_version_id",
      "revision",
      "schema_version",
      "body",
      "source",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at",
    ])) as unknown as CanvasDraftRow[];
  return rows[0];
}

/** The draft row FOR UPDATE — publish/restore lock it before deciding. */
export async function lockDraftByCanvas(
  tx: Knex.Transaction,
  companyId: string,
  canvasId: string,
): Promise<CanvasDraftRow | undefined> {
  return (await tx("canvas_draft")
    .where({ canvas_id: canvasId, company_id: companyId })
    .forUpdate()
    .first()) as CanvasDraftRow | undefined;
}

/** The publish tail: the draft is consumed once its body is snapshotted. */
export async function deleteDraftByCanvas(
  tx: Knex.Transaction,
  companyId: string,
  canvasId: string,
): Promise<void> {
  await tx("canvas_draft")
    .where({ canvas_id: canvasId, company_id: companyId })
    .delete();
}

/**
 * One published snapshot of one canvas — the (company_id, canvas_id) pair
 * in the WHERE keeps a version id from ever resolving through another
 * canvas (defense in depth alongside the composite FK).
 */
export async function findVersionById(
  db: Qb,
  companyId: string,
  canvasId: string,
  versionId: string,
): Promise<CanvasVersionRow | undefined> {
  return (await db("canvas_version")
    .where({
      id: versionId,
      canvas_id: canvasId,
      company_id: companyId,
    })
    .first()) as CanvasVersionRow | undefined;
}

/**
 * Summary columns of a published version — everything the history list
 * needs EXCEPT the immutable body, which is fetched per-version only.
 */
export interface CanvasVersionSummaryRow {
  id: string;
  canvas_id: string;
  version_no: number;
  schema_version: number;
  change_summary: string | null;
  published_by: string;
  published_at: Date | string;
}

/**
 * Every published version of one canvas, newest first (task 2.5 history
 * list). SUMMARY columns only — bodies ship through findVersionById, one
 * snapshot per request. Versions are bounded per canvas (publish is a
 * deliberate manual action — tens, never thousands), so the whole ordered
 * list is returned without a cursor.
 */
export async function listVersionsByCanvas(
  db: Qb,
  companyId: string,
  canvasId: string,
): Promise<CanvasVersionSummaryRow[]> {
  return (await db("canvas_version")
    .where({ canvas_id: canvasId, company_id: companyId })
    .orderBy("version_no", "desc")
    .select([
      "id",
      "canvas_id",
      "version_no",
      "schema_version",
      "change_summary",
      "published_by",
      "published_at",
    ])) as CanvasVersionSummaryRow[];
}

/**
 * Highest published version_no of a canvas — call only while the canvas
 * row is held FOR UPDATE so the next number cannot race (task 2.4).
 */
export async function maxVersionNo(
  tx: Knex.Transaction,
  companyId: string,
  canvasId: string,
): Promise<number> {
  const row = (await tx("canvas_version")
    .where({ company_id: companyId, canvas_id: canvasId })
    .max("version_no as max")
    .first()) as { max: number | null } | undefined;
  return row?.max ?? 0;
}

/** INSERT one immutable published snapshot (task 2.4). */
export async function insertVersion(
  tx: Knex.Transaction,
  row: {
    company_id: string;
    canvas_id: string;
    version_no: number;
    schema_version: number;
    body: CanvasBody;
    change_summary: string | null;
    provenance: Record<string, unknown> | null;
    published_by: string;
    /** Seed-only: pin the historical publish date instead of now(). */
    published_at?: string;
  },
): Promise<CanvasVersionRow> {
  const rows = (await tx("canvas_version").insert(
    { ...row, body: JSON.stringify(row.body) },
    [
      "id",
      "company_id",
      "canvas_id",
      "version_no",
      "schema_version",
      "body",
      "change_summary",
      "provenance",
      "published_by",
      "published_at",
    ],
  )) as unknown as CanvasVersionRow[];
  return rows[0];
}

/** Point the canvas head at a freshly published version. */
export async function setCanvasCurrentVersion(
  tx: Knex.Transaction,
  companyId: string,
  canvasId: string,
  versionId: string,
): Promise<void> {
  await tx("canvas")
    .where({ id: canvasId, company_id: companyId })
    .update({ current_version_id: versionId });
}

/** Flag the canvas archived — archive is a state change, never a delete. */
export async function archiveCanvasRow(
  tx: Knex.Transaction,
  companyId: string,
  canvasId: string,
  archivedBy: string,
): Promise<void> {
  await tx("canvas")
    .where({ id: canvasId, company_id: companyId })
    .update({
      status: "archived",
      archived_at: tx.fn.now(),
      archived_by: archivedBy,
    });
}

/** Reassign the canvas owner (task 2.4 transferOwner — owner role only). */
export async function transferCanvasOwner(
  tx: Knex.Transaction,
  companyId: string,
  canvasId: string,
  newOwnerId: string,
): Promise<void> {
  await tx("canvas")
    .where({ id: canvasId, company_id: companyId })
    .update({ owner_user_id: newOwnerId });
}
