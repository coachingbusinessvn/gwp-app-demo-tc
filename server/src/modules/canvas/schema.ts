import { z } from "zod";

/**
 * Request-body schemas for the canvas endpoints (task 2.3, spec §5).
 *
 * The envelope is .strict() — only the writable fields pass. `body` is the
 * canonical canvas document (shared/canvas/schema.ts): it must be a JSON
 * object here and is deep-validated draft-mode by validateCanvas in the
 * service — server-managed fields (company_id, owner_user_id, version ids)
 * can never ride inside it because CanvasBodySchema is .strict() itself.
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
