import { z } from "zod";

/**
 * BYOK AI settings input (spec §7.1/§7.3, task 3.1).
 *
 * - apiKey is optional on PUT: absent preserves the stored key. Explicit
 *   clearing is a separate operation (DELETE /settings/ai/key), so `null`
 *   is rejected here — an accidental null must never silently wipe a key.
 * - timeoutSeconds / maxOutputTokens carry the spec's pilot bounds
 *   (≤180s, ≤8192) with the same values as defaults.
 * - Strict: unknown keys are a 400, not a silent drop.
 */
export const AI_TIMEOUT_MAX_SECONDS = 180;
export const AI_MAX_OUTPUT_TOKENS = 8192;

export const aiSettingsPutSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().trim().min(1).max(500),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().min(1).max(512).optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(5)
      .max(AI_TIMEOUT_MAX_SECONDS)
      .default(AI_TIMEOUT_MAX_SECONDS),
    maxOutputTokens: z
      .number()
      .int()
      .min(1)
      .max(AI_MAX_OUTPUT_TOKENS)
      .default(AI_MAX_OUTPUT_TOKENS),
  })
  .strict();

export type AiSettingsInput = z.infer<typeof aiSettingsPutSchema>;
