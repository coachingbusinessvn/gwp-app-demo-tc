import { z } from "zod";

/**
 * Request-body schemas for the auth endpoints (spec §8). Password length is
 * validated loosely here — policy (min 12) is enforced at setup/change time;
 * login only needs a non-empty string to verify against the stored hash.
 */
export const loginBodySchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(256),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
