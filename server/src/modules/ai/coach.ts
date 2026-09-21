import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Knex } from "knex";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import type { CanvasBody } from "../../../../shared/canvas/schema.js";
import { toMarkdown } from "../../../../shared/canvas/markdown.js";
import { createPolicy } from "../authorization/policy.js";
import { createCanvasService } from "../canvas/service.js";
import { complete } from "./adapter.js";
import { AI_INPUT_MAX_BYTES, AI_INPUT_TOO_LARGE } from "./renderer.js";
import type {
  AiRunsService,
  RunDriver,
  RunDriverResult,
} from "./runs.js";

/**
 * Canvas Coach assistant (task 3.5, spec §7.3): grades a canvas against
 * the frozen rubric v3.0 and returns epistemically labelled advice.
 *
 * The coach NEVER mutates the canvas — its run produces a read-only
 * preview. Server-side validation is the trust boundary: criterion ids
 * and max allocations come from the versioned rubric (source:
 * Skill/canvas-coach/references/grading.md), not from the model; every
 * evidence/source ref must resolve to a real row id or section token of
 * the input canvas, so invented citations are rejected outright.
 */

export const COACH_RUBRIC_VERSION = "3.0";

/** Frozen rubric v3.0 — allocations sum to exactly 100. */
export const COACH_RUBRIC = [
  { id: "goal", max: 8 },
  { id: "key_result_critical_outputs", max: 20 },
  { id: "solution_direction_lever_behaviors", max: 30 },
  { id: "conditions_six_boxes", max: 12 },
  { id: "action_experiment", max: 10 },
  { id: "follow_up_evidence", max: 20 },
] as const;

export const COACH_OUTPUT_INVALID = "COACH_OUTPUT_INVALID";
export const RUBRIC_VERSION_MISMATCH = "RUBRIC_VERSION_MISMATCH";
export const UNKNOWN_CRITERION = "UNKNOWN_CRITERION";
export const MISSING_CRITERION = "MISSING_CRITERION";
export const DUPLICATE_CRITERION = "DUPLICATE_CRITERION";
export const CRITERION_MAX_MISMATCH = "CRITERION_MAX_MISMATCH";
export const SCORE_OUT_OF_RANGE = "SCORE_OUT_OF_RANGE";
export const SCORE_TOTAL_MISMATCH = "SCORE_TOTAL_MISMATCH";
export const MISSING_EVIDENCE = "MISSING_EVIDENCE";
export const UNKNOWN_EVIDENCE_REFERENCE = "UNKNOWN_EVIDENCE_REFERENCE";
export const FACT_REQUIRES_EVIDENCE = "FACT_REQUIRES_EVIDENCE";

export const AdviceKind = z.enum([
  "Fact",
  "Interpretation",
  "Assumption",
  "Hypothesis",
  "Recommendation",
]);

const coachCriterionSchema = z
  .object({
    id: z.string().min(1).max(64),
    score: z.number().int(),
    max: z.number().int(),
    evidenceRefs: z.array(z.string().max(64)).max(50),
    note: z.string().max(2000).optional(),
  })
  .strict();

const coachOutputSchema = z
  .object({
    rubricVersion: z.string().min(1).max(32),
    criteria: z.array(coachCriterionSchema).max(20),
    total: z.number().int(),
    advice: z
      .array(
        z
          .object({
            kind: AdviceKind,
            text: z.string().min(1).max(4000),
            sourceRefs: z.array(z.string().max(64)).max(50).default([]),
            confidence: z.enum(["low", "medium", "high"]).optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export type CoachOutput = z.infer<typeof coachOutputSchema>;

export interface CoachPreview {
  kind: "coach";
  /** null when the model output failed validation — issues say why. */
  output: CoachOutput | null;
  issues: { severity: "error"; code: string; message: string }[];
  canvasStage: string;
}

function coachError(code: string, message: string): AppError {
  // The code leads the message so previews show a stable diagnostic and
  // callers can match on either err.code or the message prefix.
  return new AppError(422, code, `${code}: ${message}`);
}

/**
 * The id universe a coach may cite: every list row id plus the scalar
 * section tokens — the ONLY legal evidence refs for this canvas.
 */
export function canvasRefSet(canvas: CanvasBody): Set<string> {
  const refs = new Set<string>(["meta", "goal", "kr", "solution", "risks"]);
  for (const list of [
    canvas.outputs,
    canvas.behaviors,
    canvas.boxes,
    canvas.actions,
    canvas.plan,
    canvas.observed,
    canvas.reviews,
  ]) {
    for (const row of list) refs.add(row.id);
  }
  return refs;
}

/**
 * Validate a parsed coach answer against the frozen rubric and the input
 * canvas. Throws AppError with a stable `COACH_*`/score code on every
 * violation — the model's self-reported max/total are never trusted.
 */
export function validateCoachOutput(
  raw: unknown,
  canvas: CanvasBody,
): CoachOutput {
  const parsed = coachOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw coachError(
      COACH_OUTPUT_INVALID,
      "Kết quả coach không đúng cấu trúc JSON quy định",
    );
  }
  const out = parsed.data;
  if (out.rubricVersion !== COACH_RUBRIC_VERSION) {
    throw coachError(
      RUBRIC_VERSION_MISMATCH,
      `rubricVersion ${out.rubricVersion} — server yêu cầu ${COACH_RUBRIC_VERSION}`,
    );
  }

  const rubricById = new Map<string, number>(
    COACH_RUBRIC.map((c) => [c.id, c.max]),
  );
  const seen = new Set<string>();
  for (const c of out.criteria) {
    if (!rubricById.has(c.id)) {
      throw coachError(UNKNOWN_CRITERION, `Criterion không hợp lệ: ${c.id}`);
    }
    if (seen.has(c.id)) {
      throw coachError(DUPLICATE_CRITERION, `Criterion trùng: ${c.id}`);
    }
    seen.add(c.id);
  }
  for (const r of COACH_RUBRIC) {
    if (!seen.has(r.id)) {
      throw coachError(MISSING_CRITERION, `Thiếu criterion: ${r.id}`);
    }
  }

  const refs = canvasRefSet(canvas);
  let sum = 0;
  for (const c of out.criteria) {
    const max = rubricById.get(c.id)!;
    if (c.max !== max) {
      throw coachError(
        CRITERION_MAX_MISMATCH,
        `${c.id}.max=${c.max} — rubric quy định ${max}`,
      );
    }
    if (c.score < 0 || c.score > max) {
      throw coachError(
        SCORE_OUT_OF_RANGE,
        `${c.id}.score=${c.score} ngoài khoảng 0..${max}`,
      );
    }
    if (c.score > 0 && c.evidenceRefs.length === 0) {
      throw coachError(
        MISSING_EVIDENCE,
        `${c.id} có điểm nhưng không trích evidence — rubric yêu cầu trích dẫn`,
      );
    }
    for (const ref of c.evidenceRefs) {
      if (!refs.has(ref)) {
        throw coachError(
          UNKNOWN_EVIDENCE_REFERENCE,
          `Evidence ref không tồn tại trong canvas: ${ref}`,
        );
      }
    }
    sum += c.score;
  }
  if (out.total !== sum) {
    throw coachError(
      SCORE_TOTAL_MISMATCH,
      `total=${out.total} nhưng tổng criteria=${sum}`,
    );
  }

  for (const a of out.advice) {
    for (const ref of a.sourceRefs) {
      if (!refs.has(ref)) {
        throw coachError(
          UNKNOWN_EVIDENCE_REFERENCE,
          `Source ref không tồn tại trong canvas: ${ref}`,
        );
      }
    }
    // A Fact claims direct evidence — asserting one with no source ref is
    // confidence laundering: an unverified claim wearing a Fact label.
    if (a.kind === "Fact" && a.sourceRefs.length === 0) {
      throw coachError(
        FACT_REQUIRES_EVIDENCE,
        "Advice loại Fact bắt buộc có ít nhất một sourceRef",
      );
    }
  }
  return out;
}

/**
 * Extract the JSON object from a model answer: prefer a fenced ```json
 * block, else first '{' to last '}'. Incomplete/answerless output yields
 * null — the driver turns that into a preview issue, not a crash.
 */
export function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  const candidate = fenced
    ? fenced[1]!
    : (() => {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        return start !== -1 && end > start ? text.slice(start, end + 1) : null;
      })();
  if (candidate === null) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function createCoachService({
  db,
  clock,
  config,
  runs: _runs,
}: {
  db: Knex;
  clock: Clock;
  config: Config;
  runs: AiRunsService;
}) {
  const policy = createPolicy(db);
  const canvas = createCanvasService({ db, policy, clock });

  function loadPrompt(): { text: string; version: string } {
    const dir = resolve("server/prompts/coach");
    const manifest = JSON.parse(
      readFileSync(resolve(dir, "manifest.json"), "utf8"),
    ) as { promptVersion: string; sha256: string };
    const text = readFileSync(resolve(dir, "instruction.md"), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== manifest.sha256) {
      throw new AppError(
        500,
        "AI_INTERNAL",
        "Prompt coach lệch manifest — từ chối chạy",
      );
    }
    return { text, version: manifest.promptVersion };
  }

  /**
   * Read-only grading run: current canvas (draft or captured published
   * base) → canonical Markdown → local model → schema/rubric validation.
   * A malformed answer lands in the preview as an issue; the run still
   * records succeeded-with-errors so the caller can show the diagnostic.
   */
  const driver: RunDriver = async ({
    run,
    actor,
    emit,
    signal,
    config: aiCfg,
    input,
  }) => {
    const prompt = loadPrompt();
    // ai_run_target_check guarantees canvas_id on non-oracle runs.
    const canvasId = run.canvas_id;
    if (!canvasId) {
      throw new AppError(500, "AI_INTERNAL", "Run coach thiếu canvas");
    }
    const detail = await canvas.getCanvas(actor, canvasId);
    const source =
      detail.draft?.body ??
      (run.base_version_id
        ? (
            await canvas.getVersion(
              actor,
              canvasId,
              run.base_version_id,
            )
          ).body
        : null);
    if (!source) {
      throw new AppError(
        409,
        "AI_BASE_CHANGED",
        "Canvas chưa có nội dung để AI đánh giá",
      );
    }

    const v1md = toMarkdown(source).text;
    const userContent =
      `## Canvas cần đánh giá\n\n${v1md}\n\n` +
      `## Ghi chú phiên\n\n${input.notes?.trim() || "(không có ghi chú)"}`;
    if (Buffer.byteLength(userContent, "utf8") > AI_INPUT_MAX_BYTES) {
      throw new AppError(
        413,
        AI_INPUT_TOO_LARGE,
        "Nội dung gửi AI vượt 1 MiB — rút gọn ghi chú",
      );
    }
    const result = await complete({
      config: aiCfg,
      messages: [
        { role: "system", content: prompt.text },
        { role: "user", content: userContent },
      ],
      maxOutputTokens: aiCfg.maxOutputTokens,
      signal,
      onDelta: (t) => emit({ type: "delta", text: t }),
    });

    const preview: CoachPreview = {
      kind: "coach",
      output: null,
      issues: [],
      canvasStage: source.meta.stage,
    };
    const raw = extractJsonObject(result.text);
    if (raw === null) {
      preview.issues.push({
        severity: "error",
        code: COACH_OUTPUT_INVALID,
        message: "Kết quả coach không chứa JSON hợp lệ.",
      });
    } else {
      try {
        preview.output = validateCoachOutput(raw, source);
      } catch (err) {
        preview.issues.push({
          severity: "error",
          code: err instanceof AppError ? err.code : COACH_OUTPUT_INVALID,
          message:
            err instanceof AppError ? err.message : "Kết quả coach không hợp lệ.",
        });
      }
    }
    const r: RunDriverResult = {
      preview,
      usage: result.usage,
      promptVersion: prompt.version,
    };
    return r;
  };

  return { driver };
}

export type CoachService = ReturnType<typeof createCoachService>;
