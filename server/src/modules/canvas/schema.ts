import { z } from "zod";

/**
 * Request-body schemas for the canvas endpoints (task 2.3/2.4, spec §5).
 *
 * Every envelope is .strict() — only the writable fields pass. `body` is
 * the canonical canvas document (shared/canvas/schema.ts): it must be a
 * JSON object here and is deep-validated draft-mode by validateCanvas in
 * the service — server-managed fields (company_id, owner_user_id, version
 * ids) can never ride inside it because CanvasBodySchema is .strict()
 * itself.
 */
const nameField = z.string().trim().min(1).max(200);

export const createCanvasBodySchema = z
  .object({
    /** The subject the canvas belongs to — a user of the same company. */
    ownerUserId: z.uuid(),
    name: nameField,
    body: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CreateCanvasBody = z.infer<typeof createCanvasBodySchema>;

/**
 * PUT /canvases/:id/draft — optimistic-concurrency save (task 2.4).
 * expectedRevision is the draft revision the client read; baseVersionId is
 * the published version the draft branched from (null before the first
 * publish). Either one being stale is 409 DRAFT_CONFLICT.
 */
export const saveDraftBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    baseVersionId: z.uuid().nullable(),
    body: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SaveDraftBody = z.infer<typeof saveDraftBodySchema>;

/**
 * POST /canvases/:id/publish — publish the live draft (task 2.4).
 * idempotencyKey binds the write to a write_receipt row: a retry with the
 * same key replays the stored versionId; the same key carrying a different
 * payload is 409. expectedRevision is the same CAS as saveDraft.
 */
export const publishBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    idempotencyKey: z.string().trim().min(1).max(200),
    changeSummary: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type PublishBody = z.infer<typeof publishBodySchema>;

/**
 * POST /canvases/:id/versions/:versionId/restore — copy a published
 * snapshot into the shared draft (task 2.4). With no live draft the body
 * may be empty; with one, BOTH expectedRevision (its current revision) and
 * confirm:true are required — restore never silently discards in-progress
 * work, it answers 409 DRAFT_CONFLICT instead.
 */
export const restoreBodySchema = z
  .object({
    expectedRevision: z.number().int().min(1).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();
export type RestoreBody = z.infer<typeof restoreBodySchema>;

/**
 * POST /canvases/:id/transfer — reassign the canvas owner (task 2.4).
 * Owner-role only; the target must be an active user of the same company.
 */
export const transferBodySchema = z
  .object({
    newOwnerId: z.uuid(),
  })
  .strict();
export type TransferBody = z.infer<typeof transferBodySchema>;
