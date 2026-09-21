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

/**
 * AI run admission (task 3.3, spec §7.3).
 *
 * - `consent` must be literally true — the client shows the notice and
 *   sends the flag; the server re-enforces it, so a UI that skips the
 *   step cannot start a run.
 * - `idempotencyKey` is REQUIRED: a retried POST must replay, not launch
 *   a second upstream call. Same key + different input → 409.
 * - `notes` is optional free text that shapes the run; it is hashed into
 *   input_hash and never persisted (spec: no raw prompts in the DB).
 */
export const AI_NOTES_MAX_CHARS = 20_000;
/** Transcripts are long-form user data; the driver's byte cap is the real bound. */
export const AI_TRANSCRIPT_MAX_CHARS = 500_000;

export const aiRunStartSchema = z
  .object({
    assistant: z.enum(["renderer", "coach", "oracle"]),
    canvasId: z.string().uuid().optional(),
    sessionId: z.string().uuid().optional(),
    transcript: z.string().trim().min(1).max(AI_TRANSCRIPT_MAX_CHARS).optional(),
    notes: z.string().max(AI_NOTES_MAX_CHARS).optional(),
    consent: z.boolean().optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict()
  .superRefine((v, ctx) => {
    // The oracle grades a coaching SESSION (task 4.2): sessionId+transcript
    // are required and canvas fields must not be mixed in. Canvas
    // assistants still require canvasId and take no session input.
    if (v.assistant === "oracle") {
      if (!v.sessionId) {
        ctx.addIssue({ code: "custom", path: ["sessionId"], message: "required" });
      }
      if (!v.transcript) {
        ctx.addIssue({ code: "custom", path: ["transcript"], message: "required" });
      }
      if (v.canvasId !== undefined) {
        ctx.addIssue({ code: "custom", path: ["canvasId"], message: "forbidden" });
      }
    } else {
      if (!v.canvasId) {
        ctx.addIssue({ code: "custom", path: ["canvasId"], message: "required" });
      }
      if (v.sessionId !== undefined) {
        ctx.addIssue({ code: "custom", path: ["sessionId"], message: "forbidden" });
      }
      if (v.transcript !== undefined) {
        ctx.addIssue({ code: "custom", path: ["transcript"], message: "forbidden" });
      }
    }
  });

export type AiRunStartInput = z.infer<typeof aiRunStartSchema>;

/**
 * Apply a staged renderer proposal (task 3.4). The request carries NO
 * body — the server applies the preview it validated. `expectedRevision`
 * must equal the revision captured at run start (null when no draft
 * existed); `acceptedWarnings` lists the issue ids the user acknowledged.
 */
export const aiRunApplySchema = z
  .object({
    expectedRevision: z.number().int().min(1).nullable(),
    acceptedWarnings: z.array(z.string().max(64)).max(200).default([]),
  })
  .strict();

export type AiRunApplyInput = z.infer<typeof aiRunApplySchema>;
