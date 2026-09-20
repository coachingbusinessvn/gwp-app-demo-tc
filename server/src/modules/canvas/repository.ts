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
