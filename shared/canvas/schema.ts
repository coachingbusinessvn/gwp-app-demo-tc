import { z } from "zod";

/**
 * Canonical canvas payload — schema_version 1 (spec §5.1).
 *
 * Single source of truth for the canvas document the server stores and the
 * editor reads/writes. Every object is `.strict()`: server-managed fields
 * (company_id, owner_user_id, version ids, …) must be rejected, never
 * silently stripped — "không dùng passthrough cho field quyền".
 *
 * Draft tolerance lives at the leaf level: blankable enum fields accept ""
 * but wrong types/refs are still rejected. Row lists enforce only their
 * schema bounds here (outputs ≤3, behaviors ≤5, exactly 6 boxes); the
 * business minimums are publish-time rules in validation.ts.
 */

/** Payload (storage) version — technical, independent of business schema. */
export const CANVAS_PAYLOAD_VERSION = 1;

/** Business canvas schema — "Canvas schema 3.0", kept verbatim in meta.schema. */
export const CANVAS_BUSINESS_SCHEMA = "3.0";

export const CANVAS_STAGES = ["DRAFT", "PILOTING", "VALIDATED"] as const;
export const BUILD_MODES = ["GUIDED", "RAPID_DRAFT"] as const;
export const GAP_LEVELS = ["Cao", "Trung bình", "Thấp"] as const;
export const PRIORITY_LEVELS = [
  "Cao",
  "Trung bình",
  "Thấp",
  "Chưa xác định",
] as const;
export const ACTION_STATUSES = [
  "Chưa bắt đầu",
  "Đang thực hiện",
  "Hoàn thành",
  "Tạm dừng",
  "Cần hỗ trợ",
] as const;
export const EVIDENCE_LAYERS = ["BEHAVIOR", "OUTPUT", "RESULT"] as const;
export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export const REVIEW_DECISIONS = ["CONTINUE", "ADJUST", "STOP"] as const;

/**
 * The six Conditions boxes — canonical bilingual names in fixed order,
 * identical to the editor's BOXES constant (canvas-online/index.html).
 */
export const SIX_BOXES = [
  "Kỳ vọng & Phản hồi | Expectations & Feedback",
  "Công cụ & Nguồn lực | Tools & Resources",
  "Hệ quả & Ghi nhận | Consequences & Recognition",
  "Kiến thức & Kỹ năng | Knowledge & Skills",
  "Vai trò & Quyền hạn | Role & Authority",
  "Động lực & Ưu tiên | Motivation & Priorities",
] as const;

export type CanvasStage = (typeof CANVAS_STAGES)[number];
export type BuildMode = (typeof BUILD_MODES)[number];
export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number];
export type SixBox = (typeof SIX_BOXES)[number];

/** Row id — stable UUID identity, used by dedup/diff and box→behavior refs. */
const rowId = z.string().uuid();

/**
 * Date-typed editor fields use <input type=date> → ISO YYYY-MM-DD or blank.
 * (kr.deadline and outputs[].deadline are intentionally free text — legacy
 * data carries "31/12/2026" and "(chưa điền)" there.)
 */
const isoDateOrBlank = z.union([z.iso.date(), z.literal("")]);

/** Enum that may stay undecided in a draft: canonical values or "". */
const enumOrBlank = (values: readonly string[]) =>
  z.union([z.enum(values as [string, ...string[]]), z.literal("")]);

/**
 * Optional structured measurement extension on an observed row (plan sketch).
 * The legacy `value` text stays verbatim; `measurement` carries the typed
 * metric reference when one exists.
 */
export const Measurement = z
  .object({
    metricId: z.string().uuid(),
    definitionRevision: z.number().int().positive(),
    layer: z.enum(EVIDENCE_LAYERS),
    date: z.iso.date(),
    value: z.number().finite(),
    unit: z.string().min(1),
    baseline: z.number().finite(),
    target: z.number().finite(),
  })
  .strict();

export const OutputRow = z
  .object({
    id: rowId,
    name: z.string(),
    current: z.string(),
    target: z.string(),
    deadline: z.string(),
    cs: z.string(),
  })
  .strict();

export const BehaviorRow = z
  .object({
    id: rowId,
    actor: z.string(),
    behavior: z.string(),
    context: z.string(),
    outputs: z.string(),
    signal: z.string(),
    freq: z.string(),
  })
  .strict();

export const BoxRow = z
  .object({
    id: rowId,
    box: z.enum(SIX_BOXES),
    condition: z.string(),
    evidence: z.string(),
    gap: enumOrBlank(GAP_LEVELS),
    priority: enumOrBlank(PRIORITY_LEVELS),
    /**
     * Link to behaviors[].id. null = "Cần xác nhận" (unconfirmed) — allowed
     * in draft, rejected at publish. Links are by id, never by name match.
     */
    behavior_id: z.string().uuid().nullable(),
    action: z.string(),
    assignee_label: z.string(),
    /** Resolved user id — server-side only, never trusted from import text. */
    assignee_user_id: z.string().uuid().optional(),
  })
  .strict();

export const ActionRow = z
  .object({
    id: rowId,
    action: z.string(),
    start: isoDateOrBlank,
    deadline: isoDateOrBlank,
    assignee_label: z.string(),
    supporter_label: z.string(),
    criteria: z.string(),
    status: z.enum(ACTION_STATUSES),
    risk: z.string(),
    assignee_user_id: z.string().uuid().optional(),
  })
  .strict();

export const PlanRow = z
  .object({
    id: rowId,
    date: isoDateOrBlank,
    layer: enumOrBlank(EVIDENCE_LAYERS),
    metric: z.string(),
    baseline: z.string(),
    target: z.string(),
    source: z.string(),
    collector: z.string(),
    verifier: z.string(),
  })
  .strict();

export const ObservedRow = z
  .object({
    id: rowId,
    date: isoDateOrBlank,
    layer: enumOrBlank(EVIDENCE_LAYERS),
    value: z.string(),
    source: z.string(),
    confidence: enumOrBlank(CONFIDENCE_LEVELS),
    learning: z.string(),
    decision: enumOrBlank(REVIEW_DECISIONS),
    verifier: z.string(),
    measurement: Measurement.optional(),
  })
  .strict();

export const ReviewRow = z
  .object({
    id: rowId,
    checkpoint: z.string(),
    date: isoDateOrBlank,
    behavior_evidence: z.string(),
    output_evidence: z.string(),
    result_evidence: z.string(),
    works: z.string(),
    not_works: z.string(),
    learning: z.string(),
    verifier: z.string(),
  })
  .strict();

export const CanvasBodySchema = z
  .object({
    schema_version: z.literal(CANVAS_PAYLOAD_VERSION),
    meta: z
      .object({
        title: z.string(),
        owner: z.string(),
        stage: z.enum(CANVAS_STAGES),
        mode: z.enum(BUILD_MODES),
        updated: isoDateOrBlank,
        schema: z.literal(CANVAS_BUSINESS_SCHEMA),
      })
      .strict(),
    goal: z
      .object({
        statement: z.string(),
        context: z.string(),
      })
      .strict(),
    kr: z
      .object({
        metric: z.string(),
        current: z.string(),
        target: z.string(),
        deadline: z.string(),
        cs: z.string(),
      })
      .strict(),
    outputs: z.array(OutputRow).max(3),
    solution: z
      .object({
        direction: z.string(),
        logic: z.string(),
      })
      .strict(),
    behaviors: z.array(BehaviorRow).max(5),
    boxes: z.array(BoxRow).length(6),
    actions: z.array(ActionRow),
    /** Free text — legacy risks[] joins to one newline-separated string. */
    risks: z.string(),
    plan: z.array(PlanRow),
    observed: z.array(ObservedRow),
    reviews: z.array(ReviewRow),
  })
  .strict();

export type CanvasBody = z.infer<typeof CanvasBodySchema>;
export type OutputRowT = z.infer<typeof OutputRow>;
export type BehaviorRowT = z.infer<typeof BehaviorRow>;
export type BoxRowT = z.infer<typeof BoxRow>;
export type ActionRowT = z.infer<typeof ActionRow>;
export type PlanRowT = z.infer<typeof PlanRow>;
export type ObservedRowT = z.infer<typeof ObservedRow>;
export type ReviewRowT = z.infer<typeof ReviewRow>;
export type MeasurementT = z.infer<typeof Measurement>;
