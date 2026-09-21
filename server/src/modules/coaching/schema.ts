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
