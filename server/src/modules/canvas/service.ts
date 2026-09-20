import { createHash } from "node:crypto";
import type { Knex } from "knex";
import type {
  ActorContext,
  Clock,
  Id,
  Page,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { withReceipt } from "../../shared/write-receipt.js";
import type { CanvasBody } from "../../../../shared/canvas/schema.js";
import { blankCanvas } from "../../../../shared/canvas/defaults.js";
import { validateCanvas } from "../../../../shared/canvas/validation.js";
import { appendAudit } from "../audit/service.js";
import {
  assertActiveActor,
  findCompanyUser,
  loadActorRoles,
} from "../authorization/repository.js";
import type { SubjectPolicy } from "../authorization/policy.js";
import {
  archiveCanvasRow,
  deleteDraftByCanvas,
  findCanvasById,
  findDraftByCanvas,
  findVersionById,
  insertCanvas,
  insertDraft,
  insertVersion,
  lockCanvasById,
  lockDraftByCanvas,
  maxVersionNo,
  setCanvasCurrentVersion,
  transferCanvasOwner,
  updateDraftCas,
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
 * Task 2.4 adds the conflict-safe write path on top: draft saves carry a
 * revision CAS predicate (UPDATE … WHERE revision), publish runs the
 * pinned order — permission → receipt lookup → draft lock/CAS+base check →
 * publish-validate → insert version → bump current_version_id → insert
 * write_receipt + audit → delete draft → commit — and lifecycle ops
 * (restore/archive/transfer) hold the canvas row FOR UPDATE inside the
 * same company lock.
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
    const canvas = await lockCanvasById(tx, actor.companyId, canvasId);
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

  /** Detail assembly shared by getCanvas and the lifecycle-op responses. */
  async function canvasDto(
    qb: Knex | Knex.Transaction,
    actor: ActorContext,
    canvas: CanvasRow,
  ): Promise<CanvasDto> {
    // Sequential on purpose: a Knex.Transaction is one connection, so
    // Promise.all here would pile concurrent queries onto it (pg warns
    // "client.query() when already executing", removed in pg@9).
    const ownerName = await findUserDisplayName(
      qb,
      actor.companyId,
      canvas.owner_user_id,
    );
    const draft = await findDraftByCanvas(qb, actor.companyId, canvas.id);
    const version =
      canvas.current_version_id === null
        ? undefined
        : await findVersionById(
            qb,
            actor.companyId,
            canvas.id,
            canvas.current_version_id,
          );
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
   * insertDraft with the race guard the EMAIL_TAKEN pattern sets
   * (users/service.ts): the canvas_one_draft unique index is the real
   * guard for any caller that skipped or lost the draft pre-check — a
   * collision is 409 DRAFT_EXISTS, never a 500.
   */
  async function insertDraft409(
    tx: Knex.Transaction,
    row: Parameters<typeof insertDraft>[1],
  ): Promise<CanvasDraftRow> {
    try {
      return await insertDraft(tx, row);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new AppError(
          409,
          "DRAFT_EXISTS",
          "Canvas đã có bản nháp — không ghi đè bản đang sửa",
        );
      }
      throw err;
    }
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
    return canvasDto(db, actor, canvas);
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
      const draft = await insertDraft409(tx, {
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

  /**
   * CAS save (task 2.4, spec §5.2): the client asserts the revision it read
   * and the published base it branched from; both must still hold. The
   * draft row is locked FOR UPDATE inside the company lock, then the
   * UPDATE carries the same revision predicate as a second guard — a
   * mismatch is 409 DRAFT_CONFLICT, a missing draft is the uniform 404.
   * The body is re-validated draft-mode and assignee references re-checked
   * exactly like on create.
   */
  async function saveDraft(
    actor: ActorContext,
    canvasId: Id,
    input: {
      expectedRevision: number;
      baseVersionId: Id | null;
      body: unknown;
    },
  ): Promise<DraftDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await assertWriteIn(tx, actor, canvasId);
      const body = requireValidDraftBody(input.body);
      await requireCompanyAssignees(tx, actor.companyId, body);

      const draft = await lockDraftByCanvas(tx, actor.companyId, canvasId);
      if (!draft) throw notFound();
      if (draft.revision !== input.expectedRevision) {
        throw new AppError(
          409,
          "DRAFT_CONFLICT",
          "Bản nháp đã thay đổi — tải lại trước khi lưu",
        );
      }
      if (draft.base_version_id !== input.baseVersionId) {
        // Stale base: the head moved since the client's read.
        throw new AppError(
          409,
          "DRAFT_CONFLICT",
          "Bản nháp đã đổi phiên bản gốc — tải lại trước khi lưu",
        );
      }
      const updated = await updateDraftCas(
        tx,
        actor.companyId,
        canvasId,
        input.expectedRevision,
        { body, updated_by: actor.userId },
      );
      // Unreachable while the company lock serializes writers — the CAS
      // predicate stays so a lock-free future caller still cannot clobber.
      if (!updated) {
        throw new AppError(
          409,
          "DRAFT_CONFLICT",
          "Bản nháp đã thay đổi — tải lại trước khi lưu",
        );
      }
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "canvas.draft.save",
        targetType: "canvas",
        targetId: canvasId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { version: updated.revision },
      });
      return toDraftDto(updated);
    });
  }

  /**
   * Publish (task 2.4, spec §5.2) — pinned order:
   *   permission → receipt lookup → lock draft / check expectedRevision +
   *   baseVersionId → publish-validate → INSERT canvas_version →
   *   UPDATE canvas.current_version_id → INSERT write_receipt + audit →
   *   DELETE canvas_draft → COMMIT.
   *
   * Permission (active actor, subject access) runs BEFORE the receipt
   * lookup so a revoked actor can never replay a stored result. The
   * receipt makes retries safe: same (scope, key) + same request hash
   * replays the stored versionId; same key + different hash is 409.
   * The version number is max(version_no)+1 taken while the canvas row is
   * held FOR UPDATE, so concurrent publishes can never share a number —
   * the UNIQUE(canvas_id, version_no) index is the backstop.
   */
  async function publish(
    actor: ActorContext,
    canvasId: Id,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      changeSummary?: string;
    },
  ): Promise<{ versionId: Id; versionNo: number }> {
    // What the idempotency key binds to: the publish decision for THIS
    // canvas — the draft revision and the summary. The scope already pins
    // company+canvas; the hash detects same-key/different-payload reuse.
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          canvasId,
          expectedRevision: input.expectedRevision,
          changeSummary: input.changeSummary ?? null,
        }),
      )
      .digest("hex");

    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await assertActiveActor(tx, actor.companyId, actor.userId);
      const canvas = await lockCanvasById(tx, actor.companyId, canvasId);
      if (!canvas) throw notFound();
      await policy.assertSubjectAccess(actor, canvas.owner_user_id, tx);

      const scope = `canvas.publish:${actor.companyId}:${canvasId}`;
      let publishedNo: number | undefined;
      const receipt = await withReceipt(
        tx,
        scope,
        input.idempotencyKey,
        requestHash,
        async () => {
          // --- the write: runs only when no live receipt exists --------
          if (canvas.status === "archived") {
            throw new AppError(
              409,
              "CANVAS_ARCHIVED",
              "Canvas đã lưu trữ — không thể chỉnh sửa",
            );
          }
          const draft = await lockDraftByCanvas(
            tx,
            actor.companyId,
            canvasId,
          );
          if (!draft) throw notFound();
          if (draft.revision !== input.expectedRevision) {
            throw new AppError(
              409,
              "DRAFT_CONFLICT",
              "Bản nháp đã thay đổi — tải lại trước khi publish",
            );
          }
          if (draft.base_version_id !== canvas.current_version_id) {
            throw new AppError(
              409,
              "DRAFT_CONFLICT",
              "Bản nháp không còn trên phiên bản hiện tại — tải lại trước khi publish",
            );
          }
          // Publish-mode completeness: schema/referential errors AND the
          // business minimums — issue paths ride in details.fields.
          const errors = validateCanvas(draft.body, "publish").filter(
            (i) => i.severity === "error",
          );
          if (errors.length > 0) {
            throw new AppError(
              400,
              "INVALID_INPUT",
              "Canvas chưa đủ điều kiện publish",
              { fields: [...new Set(errors.map((i) => i.path))] },
            );
          }
          const versionNo = (await maxVersionNo(
            tx,
            actor.companyId,
            canvasId,
          )) + 1;
          const version = await insertVersion(tx, {
            company_id: actor.companyId,
            canvas_id: canvasId,
            version_no: versionNo,
            schema_version: draft.schema_version,
            body: draft.body,
            change_summary: input.changeSummary ?? null,
            provenance: { source: draft.source },
            published_by: actor.userId,
          });
          await setCanvasCurrentVersion(
            tx,
            actor.companyId,
            canvasId,
            version.id,
          );
          publishedNo = versionNo;
          return version.id;
        },
      );

      let versionNo = publishedNo;
      if (receipt.replayed) {
        // Replay: the receipt only stores the result id — re-read the
        // version row for the number (the row is immutable, never gone).
        const version = await findVersionById(
          tx,
          actor.companyId,
          canvasId,
          receipt.resultId,
        );
        if (!version) {
          throw new AppError(500, "INTERNAL", "Mất phiên bản đã ghi nhận");
        }
        versionNo = version.version_no;
      } else {
        // Fresh write: receipt row is in — audit + consume the draft
        // (pinned tail of the publish order).
        await appendAudit(tx, {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: "canvas.publish",
          targetType: "canvas",
          targetId: canvasId,
          outcome: "success",
          requestId: actor.requestId,
          metadata: { version: versionNo },
        });
        await deleteDraftByCanvas(tx, actor.companyId, canvasId);
      }
      return { versionId: receipt.resultId, versionNo: versionNo! };
    });
  }

  /**
   * Restore (task 2.4): copy a published version's body into the shared
   * draft — history is NEVER mutated (canvas_version is insert-only for
   * the runtime role; restore writes only canvas_draft). No draft → a new
   * draft is created with revision 1, base = the CURRENT head (not the
   * restored version: the draft still branches from head, its content
   * just starts at the old body). A live draft is never silently
   * discarded: the caller must pass its current expectedRevision AND
   * confirm:true; anything less is 409 DRAFT_CONFLICT.
   */
  async function restore(
    actor: ActorContext,
    canvasId: Id,
    versionId: Id,
    input: { expectedRevision?: number; confirm?: boolean },
  ): Promise<DraftDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const canvas = await assertWriteIn(tx, actor, canvasId);
      const version = await findVersionById(
        tx,
        actor.companyId,
        canvasId,
        versionId,
      );
      if (!version) throw notFound();

      const existing = await lockDraftByCanvas(tx, actor.companyId, canvasId);
      let draft: CanvasDraftRow;
      if (existing) {
        const confirmed =
          input.confirm === true &&
          input.expectedRevision === existing.revision;
        if (!confirmed) {
          throw new AppError(
            409,
            "DRAFT_CONFLICT",
            "Canvas có bản nháp đang sửa — cần expectedRevision và confirm để thay thế",
          );
        }
        const updated = await updateDraftCas(
          tx,
          actor.companyId,
          canvasId,
          existing.revision,
          {
            body: version.body,
            base_version_id: canvas.current_version_id,
            schema_version: version.schema_version,
            updated_by: actor.userId,
          },
        );
        if (!updated) {
          throw new AppError(
            409,
            "DRAFT_CONFLICT",
            "Bản nháp đã thay đổi — tải lại trước khi restore",
          );
        }
        draft = updated;
      } else {
        draft = await insertDraft409(tx, {
          company_id: actor.companyId,
          canvas_id: canvasId,
          base_version_id: canvas.current_version_id,
          revision: 1,
          schema_version: version.schema_version,
          body: version.body,
          source: "manual",
          created_by: actor.userId,
          updated_by: actor.userId,
        });
      }
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "canvas.restore",
        targetType: "canvas",
        targetId: canvasId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { version: version.version_no },
      });
      return toDraftDto(draft);
    });
  }

  /**
   * Archive (task 2.4, spec §9): a flag flip, never a delete — every write
   * gate (assertWriteIn) then blocks the canvas with 409 CANVAS_ARCHIVED
   * while reads stay open. Archiving twice is the same 409 — the second
   * call is a state conflict, not a no-op.
   */
  async function archive(
    actor: ActorContext,
    canvasId: Id,
  ): Promise<CanvasDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const canvas = await assertWriteIn(tx, actor, canvasId);
      await archiveCanvasRow(tx, actor.companyId, canvasId, actor.userId);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "canvas.archive",
        targetType: "canvas",
        targetId: canvasId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { status: "archived" },
      });
      const updated = await findCanvasById(tx, actor.companyId, canvasId);
      return canvasDto(tx, actor, updated ?? canvas);
    });
  }

  /**
   * Transfer ownership (task 2.4): OWNER ROLE ONLY — checked on fresh role
   * rows before anything else, so member/manager/admin are denied by role
   * (403) even where subject access would pass; this is deliberately not
   * just the subject-404 boundary. The target must be an ACTIVE user of
   * the same company — foreign/unknown ids are the uniform 404, an
   * inactive one is 409 USER_NOT_ACTIVE (same convention as createCanvas).
   * After the flip, subject access follows the NEW owner immediately.
   */
  async function transferOwner(
    actor: ActorContext,
    canvasId: Id,
    newOwnerId: Id,
  ): Promise<CanvasDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await assertActiveActor(tx, actor.companyId, actor.userId);
      const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
      if (!roles.includes("owner")) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ owner được chuyển quyền sở hữu canvas",
        );
      }
      const canvas = await lockCanvasById(tx, actor.companyId, canvasId);
      if (!canvas) throw notFound();
      // Defense in depth — the owner role already scopes the whole company,
      // so this can only deny if the policy rules ever change.
      await policy.assertSubjectAccess(actor, canvas.owner_user_id, tx);
      if (canvas.status === "archived") {
        throw new AppError(
          409,
          "CANVAS_ARCHIVED",
          "Canvas đã lưu trữ — không thể chỉnh sửa",
        );
      }
      const target = await findCompanyUser(tx, actor.companyId, newOwnerId);
      if (!target) throw notFound();
      if (target.status !== "active") {
        throw new AppError(
          409,
          "USER_NOT_ACTIVE",
          "Người dùng không ở trạng thái hoạt động",
        );
      }
      await transferCanvasOwner(tx, actor.companyId, canvasId, newOwnerId);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "canvas.transfer",
        targetType: "canvas",
        targetId: canvasId,
        outcome: "success",
        requestId: actor.requestId,
        // Metadata only: which field changed and to whom — a transfer
        // audit without the destination is useless. User ids are opaque
        // UUIDs already visible to audit readers (owner/admin).
        metadata: { field: "owner_user_id", to: newOwnerId },
      });
      const updated = await findCanvasById(tx, actor.companyId, canvasId);
      return canvasDto(tx, actor, updated ?? canvas);
    });
  }

  return {
    createCanvas,
    getCanvas,
    listCanvases,
    getVersion,
    assertWrite,
    createDraft,
    saveDraft,
    publish,
    restore,
    archive,
    transferOwner,
  };
}

export type CanvasService = ReturnType<typeof createCanvasService>;
