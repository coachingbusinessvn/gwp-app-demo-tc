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

/**
 * POST /auth/activate + /auth/reset (task 1.4): the one-time token plus the
 * new password (min 12 — the same strength rule as setup). Token format is
 * opaque here; unknown/expired/used all collapse to INVALID_TOKEN.
 */
export const consumeCredentialBodySchema = z
  .object({
    token: z.string().min(1).max(1024),
    password: z.string().min(12).max(256),
  })
  .strict();
export type ConsumeCredentialBody = z.infer<typeof consumeCredentialBodySchema>;

/**
 * POST /auth/password — self-service change. currentPassword is only
 * verified (non-empty); newPassword carries the min-12 strength rule.
 */
export const changePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .strict();
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
