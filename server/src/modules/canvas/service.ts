import type { Knex } from "knex";
import type {
  ActorContext,
  Clock,
  Id,
  Page,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import type { CanvasBody } from "../../../../shared/canvas/schema.js";
import { blankCanvas } from "../../../../shared/canvas/defaults.js";
import { validateCanvas } from "../../../../shared/canvas/validation.js";
import { appendAudit } from "../audit/service.js";
import {
  assertActiveActor,
  findCompanyUser,
} from "../authorization/repository.js";
import type { SubjectPolicy } from "../authorization/policy.js";
import {
  findCanvasById,
  findDraftByCanvas,
  findVersionById,
  insertCanvas,
  insertDraft,
  type CanvasDraftRow,
  type CanvasRow,
  type CanvasVersionRow,
} from "./repository.js";
import {
  encodeCanvasCursor,
  findUserDisplayName,
  listScopedCanvases,
  type CanvasCursor,
  type ScopedCanvasRow,
} from "./queries.js";

/**
 * Canvas persistence behind the shared subject policy (task 2.3,
 * spec §4/§5). Every read and every write is filtered by
 * policy.assertSubjectAccess / policy.scopeSubjectIds on the canvas OWNER
 * — access = self | owner (whole company) | manager over the owner's
 * current subtree. Admin deliberately gets nothing beyond its own
 * canvases: canvases are subject content, not org metadata. Missing,
 * foreign and denied ids all surface as the same 404.
 *
 * Mutations serialize on lockCompany and append their audit row inside the
 * same transaction (spec §9) — metadata only, never canvas body content.
 * assertActiveActor re-runs under the lock so a deactivated actor cannot
 * complete an in-flight write on a stale context.
 *
 * Design decisions (documented per task brief):
 * - `name` is the canvas record's display name and is STAMPED into
 *   body.meta.title on create — the column is authoritative for lists and
 *   the body mirrors it (the request carries both but they can never
 *   diverge, so there is no mismatch error path).
 * - `assignee_user_id` inside a body must name an existing same-company
 *   user or the write is rejected 400 — a resolved reference is checked,
 *   never silently stripped and never a grant of access.
 * - Writing to an archived canvas is a state conflict → 409
 *   CANVAS_ARCHIVED (same convention as ORG_UNIT_ARCHIVED), reached only
 *   AFTER subject access — denied actors still see the uniform 404.
 * - A second POST /draft on a canvas with a live draft is 409
 *   DRAFT_EXISTS — the in-progress body is never overwritten.
 */

export interface DraftDto {
  id: Id;
  canvasId: Id;
  baseVersionId: Id | null;
  revision: number;
  schemaVersion: number;
  source: string;
  body: CanvasBody;
  createdBy: Id;
  createdAt: string;
  updatedBy: Id;
  updatedAt: string;
}

export interface VersionSummaryDto {
  id: Id;
  versionNo: number;
  schemaVersion: number;
  changeSummary: string | null;
  publishedBy: Id;
  publishedAt: string;
}

export interface CanvasVersionDto extends VersionSummaryDto {
  canvasId: Id;
  body: CanvasBody;
  provenance: Record<string, unknown> | null;
}

export interface CanvasDto {
  id: Id;
  ownerUserId: Id;
  ownerName: string;
  name: string;
  status: string;
  currentVersionId: Id | null;
  createdAt: string;
  archivedAt: string | null;
  archivedBy: Id | null;
  draft: DraftDto | null;
  currentVersion: VersionSummaryDto | null;
}

export interface CanvasListItemDto {
  id: Id;
  ownerUserId: Id;
  ownerName: string;
  name: string;
  status: string;
  hasDraft: boolean;
  currentVersionId: Id | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface CreateCanvasResult {
  id: Id;
  draft: { id: Id; revision: number };
}

function toIso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function notFound(): AppError {
  // Consistent 404 for missing/foreign/denied canvas ids (spec §2/§4).
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

function toDraftDto(row: CanvasDraftRow): DraftDto {
  return {
    id: row.id,
    canvasId: row.canvas_id,
    baseVersionId: row.base_version_id,
    revision: row.revision,
    schemaVersion: row.schema_version,
    source: row.source,
    body: row.body,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toVersionSummary(row: CanvasVersionRow): VersionSummaryDto {
  return {
    id: row.id,
    versionNo: row.version_no,
    schemaVersion: row.schema_version,
    changeSummary: row.change_summary,
    publishedBy: row.published_by,
    publishedAt: new Date(row.published_at).toISOString(),
  };
}

function toVersionDto(row: CanvasVersionRow): CanvasVersionDto {
  return {
    ...toVersionSummary(row),
    canvasId: row.canvas_id,
    body: row.body,
    provenance: row.provenance,
  };
}

function toListItem(row: ScopedCanvasRow): CanvasListItemDto {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    name: row.name,
    status: row.status,
    hasDraft: row.has_draft,
    currentVersionId: row.current_version_id,
    createdAt: new Date(row.created_at).toISOString(),
    archivedAt: toIso(row.archived_at),
  };
}

export interface CanvasDeps {
  db: Knex;
  policy: SubjectPolicy;
  clock: Clock;
}

export function createCanvasService({ db, policy, clock }: CanvasDeps) {
  /**
   * Draft-mode validation of a client-supplied canvas body. Every schema /
   * referential error becomes 400 INVALID_INPUT with the issue paths —
   * warnings do not block a draft. CanvasBodySchema is strict at every
   * level, so server-managed fields (company_id, owner_user_id, …) inside
   * the payload are already schema errors by the time this runs.
   */
  function requireValidDraftBody(raw: unknown): CanvasBody {
    const issues = validateCanvas(raw, "draft");
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new AppError(400, "INVALID_INPUT", "Nội dung canvas không hợp lệ", {
        fields: [...new Set(errors.map((i) => i.path))],
      });
    }
    return raw as CanvasBody;
  }

  /**
   * Every assignee_user_id in the body (boxes[] + actions[]) must resolve
   * to a user of this company — the field is a resolved reference, so a
   * foreign or unknown id is 400 INVALID_INPUT, never silently stripped.
   * Being named here grants the assignee nothing: access still comes only
   * from the subject policy on the canvas owner (spec §4).
   */
  async function requireCompanyAssignees(
    tx: Knex.Transaction,
    companyId: Id,
    body: CanvasBody,
  ): Promise<void> {
    const refs = new Map<string, string>();
    body.boxes.forEach((b, i) => {
      if (b.assignee_user_id !== undefined) {
        refs.set(b.assignee_user_id, `boxes.${i}.assignee_user_id`);
      }
    });
    body.actions.forEach((a, i) => {
      if (a.assignee_user_id !== undefined) {
        refs.set(a.assignee_user_id, `actions.${i}.assignee_user_id`);
      }
    });
    const bad: string[] = [];
    for (const [userId, path] of refs) {
      const user = await findCompanyUser(tx, companyId, userId);
      if (!user) bad.push(path);
    }
    if (bad.length > 0) {
      throw new AppError(
        400,
        "INVALID_INPUT",
        "assignee_user_id phải là người dùng trong công ty",
        { fields: bad },
      );
    }
  }

  /**
   * The write gate every canvas mutation goes through (also exported for
   * the Phase-4 report bridge): actor still active → canvas exists in this
   * company → subject access on the OWNER → canvas not archived. Denials
   * are the uniform 404; an archived canvas is 409 — reached only by an
   * actor who already has access. Returns the locked canvas row.
   *
   * Callers must hold lockCompany; the standalone overload opens a
   * transaction and takes the lock itself.
   */
  async function assertWriteIn(
    tx: Knex.Transaction,
    actor: ActorContext,
    canvasId: Id,
  ): Promise<CanvasRow> {
    await assertActiveActor(tx, actor.companyId, actor.userId);
    const canvas = await findCanvasById(tx, actor.companyId, canvasId);
    if (!canvas) throw notFound();
    await policy.assertSubjectAccess(actor, canvas.owner_user_id, tx);
    if (canvas.status === "archived") {
      throw new AppError(
        409,
        "CANVAS_ARCHIVED",
        "Canvas đã lưu trữ — không thể chỉnh sửa",
      );
    }
    return canvas;
  }

  async function assertWrite(
    actor: ActorContext,
    canvasId: Id,
    tx?: Knex.Transaction,
  ): Promise<void> {
    if (tx) {
      await assertWriteIn(tx, actor, canvasId);
      return;
    }
    await db.transaction(async (t) => {
      await lockCompany(t, actor.companyId);
      await assertWriteIn(t, actor, canvasId);
    });
  }

  /**
   * Create a canvas and its first shared draft atomically. The caller needs
   * subject access to ownerUserId — self for members, current subtree for
   * managers, anyone for the owner; admin can only create for itself. The
   * owner must be an ACTIVE company user (policy proves membership; the
   * status check rejects dormant accounts). `name` is stamped into
   * body.meta.title so the column and the body never diverge.
   */
  async function createCanvas(
    actor: ActorContext,
    input: { ownerUserId: Id; name: string; body: unknown },
  ): Promise<CreateCanvasResult> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await assertActiveActor(tx, actor.companyId, actor.userId);
      // Access before content validation: a denied subject is the uniform
      // 404 regardless of what the payload contains.
      await policy.assertSubjectAccess(actor, input.ownerUserId, tx);
      const owner = await findCompanyUser(
        tx,
        actor.companyId,
        input.ownerUserId,
      );
      if (!owner) throw notFound();
      if (owner.status !== "active") {
        throw new AppError(
          409,
          "USER_NOT_ACTIVE",
          "Người dùng không ở trạng thái hoạt động",
        );
      }
      const body = requireValidDraftBody(input.body);
      body.meta = { ...body.meta, title: input.name };
      await requireCompanyAssignees(tx, actor.companyId, body);

      const canvas = await insertCanvas(tx, {
        company_id: actor.companyId,
        owner_user_id: input.ownerUserId,
        name: input.name,
        created_by: actor.userId,
      });
      const draft = await insertDraft(tx, {
        company_id: actor.companyId,
        canvas_id: canvas.id,
        base_version_id: null,
        revision: 1,
        schema_version: body.schema_version,
        body,
        source: "manual",
        created_by: actor.userId,
        updated_by: actor.userId,
      });
      // Metadata-only audit — never canvas body content (spec §9).
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "canvas.create",
        targetType: "canvas",
        targetId: canvas.id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { status: "active" },
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "canvas.draft.create",
        targetType: "canvas",
        targetId: canvas.id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { version: draft.revision },
      });
      return { id: canvas.id, draft: { id: draft.id, revision: draft.revision } };
    });
  }

  /**
   * Canvas detail: metadata + the shared draft (with body — it IS the
   * working document) + the current version's summary. Subject access on
   * the owner is the only gate; absent and denied are the same 404.
   */
  async function getCanvas(actor: ActorContext, id: Id): Promise<CanvasDto> {
    const canvas = await findCanvasById(db, actor.companyId, id);
    if (!canvas) throw notFound();
    await policy.assertSubjectAccess(actor, canvas.owner_user_id);
    const [ownerName, draft, version] = await Promise.all([
      findUserDisplayName(db, actor.companyId, canvas.owner_user_id),
      findDraftByCanvas(db, actor.companyId, canvas.id),
      canvas.current_version_id === null
        ? Promise.resolve(undefined)
        : findVersionById(
            db,
            actor.companyId,
            canvas.id,
            canvas.current_version_id,
          ),
    ]);
    return {
      id: canvas.id,
      ownerUserId: canvas.owner_user_id,
      ownerName: ownerName ?? "",
      name: canvas.name,
      status: canvas.status,
      currentVersionId: canvas.current_version_id,
      createdAt: new Date(canvas.created_at).toISOString(),
      archivedAt: toIso(canvas.archived_at),
      archivedBy: canvas.archived_by,
      draft: draft ? toDraftDto(draft) : null,
      currentVersion: version ? toVersionSummary(version) : null,
    };
  }

  /**
   * Scoped keyset page: items are the canvases whose owner sits in the
   * actor's subject scope (self | company for owner | current subtree for
   * manager). An empty scope is a valid empty page — no fixture fallback,
   * no synthetic rows.
   */
  async function listCanvases(
    actor: ActorContext,
    opts: { limit: number; cursor?: CanvasCursor },
  ): Promise<Page<CanvasListItemDto>> {
    const ownerIds = await policy.scopeSubjectIds(actor);
    if (ownerIds.length === 0) return { items: [], nextCursor: null };
    const rows = await listScopedCanvases(db, actor.companyId, ownerIds, opts);
    const items = rows.slice(0, opts.limit).map(toListItem);
    return {
      items,
      nextCursor:
        rows.length > opts.limit
          ? encodeCanvasCursor(rows[opts.limit - 1])
          : null,
    };
  }

  /**
   * One published snapshot — still gated by subject access on the canvas
   * owner (spec §4: draft AND history follow the same rule), and the
   * (canvas_id, id) pair is enforced so a version id never leaks through
   * another canvas.
   */
  async function getVersion(
    actor: ActorContext,
    canvasId: Id,
    versionId: Id,
  ): Promise<CanvasVersionDto> {
    const canvas = await findCanvasById(db, actor.companyId, canvasId);
    if (!canvas) throw notFound();
    await policy.assertSubjectAccess(actor, canvas.owner_user_id);
    const version = await findVersionById(
      db,
      actor.companyId,
      canvasId,
      versionId,
    );
    if (!version) throw notFound();
    return toVersionDto(version);
  }

  /**
   * Open the canvas's shared draft (POST /canvases/:id/draft): copies the
   * current published version's body as the starting point, else a blank
   * canvas when nothing was ever published. A live draft is a hard 409 —
   * the in-progress work is never overwritten (spec §5.2).
   */
  async function createDraft(
    actor: ActorContext,
    canvasId: Id,
  ): Promise<DraftDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const canvas = await assertWriteIn(tx, actor, canvasId);
      if (await findDraftByCanvas(tx, actor.companyId, canvasId)) {
        throw new AppError(
          409,
          "DRAFT_EXISTS",
          "Canvas đã có bản nháp — không ghi đè bản đang sửa",
        );
      }
      const base =
        canvas.current_version_id === null
          ? undefined
          : await findVersionById(
              tx,
              actor.companyId,
              canvasId,
              canvas.current_version_id,
            );
      const body: CanvasBody = base ? base.body : blankCanvas(clock);
      const draft = await insertDraft(tx, {
        company_id: actor.companyId,
        canvas_id: canvasId,
        base_version_id: base?.id ?? null,
        revision: 1,
        schema_version: body.schema_version,
        body,
        source: "manual",
        created_by: actor.userId,
        updated_by: actor.userId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "canvas.draft.create",
        targetType: "canvas",
        targetId: canvasId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { version: draft.revision },
      });
      return toDraftDto(draft);
    });
  }

  return {
    createCanvas,
    getCanvas,
    listCanvases,
    getVersion,
    assertWrite,
    createDraft,
  };
}

export type CanvasService = ReturnType<typeof createCanvasService>;
