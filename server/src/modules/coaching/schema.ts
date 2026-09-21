import { z } from "zod";

/**
 * Request schemas for the coaching surface (task 4.1, spec §6).
 * Strict envelopes: server-managed fields (company, author, timestamps)
 * inside a client payload are schema errors, never silently ignored.
 */
export const createSessionBodySchema = z
  .object({
    coachUserId: z.string().uuid(),
    coacheeUserId: z.string().uuid(),
    canvasId: z.string().uuid().optional(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((v) => v.coachUserId !== v.coacheeUserId, {
    message: "coachUserId và coacheeUserId phải khác nhau",
    path: ["coacheeUserId"],
  });

export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

/**
 * Explicit report save (task 4.2): the request identifies WHICH validated
 * run preview to persist — the body content comes only from the server's
 * preview, never from the client. `idempotencyKey` makes a retried save
 * replay the same report instead of appending a duplicate version.
 */
export const saveReportBodySchema = z
  .object({
    sessionId: z.string().uuid(),
    runId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export type SaveReportBody = z.infer<typeof saveReportBodySchema>;

/**
 * Confirmed report delete (task 4.3, spec §6): the body must literally be
 * `{confirm:true}` — an absent or false flag is a 400, never a deletion.
 */
export const deleteReportBodySchema = z
  .object({
    confirm: z.literal(true),
  })
  .strict();

export type DeleteReportBody = z.infer<typeof deleteReportBodySchema>;
