import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import type { CanvasBody } from "../../../../shared/canvas/schema.js";
import type { Issue } from "../../../../shared/canvas/validation.js";
import {
  parseMarkdown,
  toMarkdown,
} from "../../../../shared/canvas/markdown.js";
import { createPolicy } from "../authorization/policy.js";
import { createCanvasService, type DraftDto } from "../canvas/service.js";
import {
  findCanvasById,
  findDraftByCanvas,
} from "../canvas/repository.js";
import { complete } from "./adapter.js";
import type {
  AiRunsService,
  RunDriver,
  RunDriverResult,
} from "./runs.js";

/**
 * Renderer assistant (task 3.4, spec §7.3): turns session notes / an
 * ORACLE coaching report into a canvas proposal.
 *
 * Trust boundaries:
 * - The model's answer is parsed by the SAME canonical parser the manual
 *   import uses — no second, looser grammar. Parse/validation errors are
 *   previewed but can never be applied.
 * - Stable IDs: proposal rows that textually match the source canvas keep
 *   the source row's id (and box→behavior links are remapped through the
 *   same id map), so apply preserves identity instead of churning ids.
 * - Apply re-checks permission and the CAPTURED base — never the current
 *   one, never a client-supplied body. The proposal itself comes from the
 *   server's preview store, not the request.
 * - AI never publishes: apply writes a draft (source='ai') through the
 *   normal canvas service; publish stays a human action.
 */

export const AI_BASE_CHANGED = "AI_BASE_CHANGED";
export const AI_WARNINGS_UNACCEPTED = "AI_WARNINGS_UNACCEPTED";
export const AI_PROPOSAL_INVALID = "AI_PROPOSAL_INVALID";
export const AI_RUN_NOT_READY = "AI_RUN_NOT_READY";
export const AI_INPUT_TOO_LARGE = "AI_INPUT_TOO_LARGE";

/** spec §7.3 pilot bound: 1 MiB of AI content per request. */
export const AI_INPUT_MAX_BYTES = 1024 * 1024;

export interface RendererIssue extends Issue {
  /** Stable id = hash(code|path|message) — apply binds acceptances to it. */
  id: string;
}

export interface RendererDiffRow {
  id: string;
  kind: "added" | "changed" | "removed" | "unchanged";
  label: string;
}

export interface RendererDiff {
  /** Per-list row movement; scalar sections collapse to changed-fields. */
  sections: {
    name: string;
    added: number;
    changed: number;
    removed: number;
    rows: RendererDiffRow[];
  }[];
  metaChanged: string[];
}

export interface RendererPreview {
  kind: "renderer";
  proposal: CanvasBody | null;
  issues: RendererIssue[];
  diff: RendererDiff | null;
  /** sha256 of the validated proposal+issues — what acceptances bind to. */
  previewHash: string;
}

function issueId(i: Issue): string {
  return (
    (i.severity === "error" ? "e-" : "w-") +
    createHash("sha256")
      .update(`${i.code}|${i.path}|${i.message}`)
      .digest("hex")
      .slice(0, 12)
  );
}

const CANVAS_H1 = /^#\s+PERFORMANCE\s+ARCHITECTURE\s+CANVAS/im;

/**
 * Pull the canonical canvas block out of the model's full answer (which
 * begins with the analysis section). The frame starts at the H1 and runs
 * to the closing fence when fenced, else to end of input.
 */
export function extractCanvasMarkdown(text: string): string | null {
  const m = CANVAS_H1.exec(text);
  if (!m || m.index === undefined) return null;
  let rest = text.slice(m.index);
  const fenceEnd = rest.indexOf("\n```");
  if (fenceEnd !== -1) rest = rest.slice(0, fenceEnd);
  return rest.trim();
}

/* ------------------------------------------------------------------ *
 * Stable-id preservation                                              *
 * ------------------------------------------------------------------ */

type RowWithId = { id: string } & Record<string, unknown>;

/**
 * Reuse source row ids for proposal rows that match on identity keys,
 * consume-once per source row. Returns the parser-id → stable-id map so
 * foreign keys (boxes[].behavior_id) can be remapped through it.
 */
function preserveIds(
  proposed: RowWithId[],
  source: RowWithId[],
  keyOf: (r: RowWithId) => string,
  idMap: Map<string, string>,
): void {
  const used = new Set<string>();
  for (const p of proposed) {
    const key = keyOf(p);
    const match = source.find(
      (s) => !used.has(s.id) && keyOf(s) === key && key !== "",
    );
    if (!match) continue;
    used.add(match.id);
    idMap.set(p.id, match.id);
    p.id = match.id;
  }
}

const norm = (v: unknown): string => String(v ?? "").trim();

function remapStableIds(proposal: CanvasBody, source: CanvasBody): void {
  const idMap = new Map<string, string>();
  preserveIds(proposal.outputs, source.outputs, (r) => norm(r.name), idMap);
  preserveIds(
    proposal.behaviors,
    source.behaviors,
    (r) => norm(r.behavior),
    idMap,
  );
  preserveIds(proposal.boxes, source.boxes, (r) => norm(r.box), idMap);
  preserveIds(proposal.actions, source.actions, (r) => norm(r.action), idMap);
  preserveIds(
    proposal.plan,
    source.plan,
    (r) => `${norm(r.date)}|${norm(r.metric)}`,
    idMap,
  );
  preserveIds(
    proposal.observed,
    source.observed,
    (r) => `${norm(r.date)}|${norm(r.value)}`,
    idMap,
  );
  preserveIds(
    proposal.reviews,
    source.reviews,
    (r) => `${norm(r.checkpoint)}|${norm(r.date)}`,
    idMap,
  );
  // Box→behavior links were resolved against parser ids — remap to the
  // stable ids just restored so the link survives id preservation.
  for (const box of proposal.boxes) {
    if (box.behavior_id && idMap.has(box.behavior_id)) {
      box.behavior_id = idMap.get(box.behavior_id)!;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Validation                                                          *
 * ------------------------------------------------------------------ */

const STAGE_RANK: Record<string, number> = {
  DRAFT: 0,
  PILOTING: 1,
  VALIDATED: 2,
};

function rendererChecks(
  proposal: CanvasBody,
  source: CanvasBody,
): Issue[] {
  const out: Issue[] = [];

  // Stage movement is a human decision — AI proposes, never silently
  // upgrades the evidence classification (spec §7.3 "stage not
  // auto-upgrade").
  if (proposal.meta.stage !== source.meta.stage) {
    const up =
      (STAGE_RANK[proposal.meta.stage] ?? 0) >
      (STAGE_RANK[source.meta.stage] ?? 0);
    out.push({
      severity: "warning",
      code: "STAGE_CHANGED",
      path: "meta.stage",
      message: up
        ? `AI đề xuất nâng stage ${source.meta.stage} → ${proposal.meta.stage} — xác nhận đủ bằng chứng trước khi áp dụng.`
        : `AI đề xuất đổi stage ${source.meta.stage} → ${proposal.meta.stage} — xác nhận trước khi áp dụng.`,
    });
  }

  // Observed evidence is epistemically load-bearing (measured result +
  // source + date). Rows the source did not have are AI additions a
  // human must confirm — never silent (spec §7.3 "no fabricated
  // observed").
  const srcObserved = new Set(
    source.observed.map((o) => `${norm(o.date)}|${norm(o.value)}`),
  );
  proposal.observed.forEach((o, i) => {
    if (norm(o.value) === "") return;
    if (!srcObserved.has(`${norm(o.date)}|${norm(o.value)}`)) {
      out.push({
        severity: "warning",
        code: "OBSERVED_PROPOSED",
        path: `observed.${i}`,
        message: `Observed Evidence mới do AI đề xuất ("${norm(o.value).slice(0, 80)}") — xác nhận ngày/nguồn thực tế trước khi áp dụng.`,
      });
    }
  });

  // Server-only fields must never arrive from generated text.
  proposal.boxes.forEach((b, i) => {
    if (b.assignee_user_id) {
      out.push({
        severity: "error",
        code: "ASSIGNEE_FORGED",
        path: `boxes.${i}.assignee_user_id`,
        message: "Đề xuất chứa assignee_user_id — trường server-side không được AI ghi.",
      });
    }
  });
  proposal.actions.forEach((a, i) => {
    if (a.assignee_user_id) {
      out.push({
        severity: "error",
        code: "ASSIGNEE_FORGED",
        path: `actions.${i}.assignee_user_id`,
        message: "Đề xuất chứa assignee_user_id — trường server-side không được AI ghi.",
      });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Diff                                                                *
 * ------------------------------------------------------------------ */

function rowLabel(section: string, r: RowWithId): string {
  const pick = (...keys: string[]) =>
    keys.map((k) => norm(r[k])).find((v) => v !== "") ?? "";
  switch (section) {
    case "outputs":
      return pick("name");
    case "behaviors":
      return pick("behavior");
    case "boxes":
      return pick("box");
    case "actions":
      return pick("action");
    case "plan":
      return `${norm(r.date)} ${norm(r.metric)}`.trim();
    case "observed":
      return `${norm(r.date)} ${norm(r.value)}`.trim();
    case "reviews":
      return `${norm(r.date)} ${norm(r.checkpoint)}`.trim();
    default:
      return "";
  }
}

const LIST_SECTIONS = [
  "outputs",
  "behaviors",
  "boxes",
  "actions",
  "plan",
  "observed",
  "reviews",
] as const;

function sameRow(a: RowWithId, b: RowWithId): boolean {
  const ka = Object.keys(a).filter((k) => k !== "id" && k !== "measurement");
  return ka.every(
    (k) =>
      JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null),
  );
}

export function diffBodies(
  proposal: CanvasBody,
  source: CanvasBody,
): RendererDiff {
  const sections = LIST_SECTIONS.map((name) => {
    const src = source[name] as unknown as RowWithId[];
    const pro = proposal[name] as unknown as RowWithId[];
    const srcById = new Map(src.map((r) => [r.id, r]));
    const proIds = new Set(pro.map((r) => r.id));
    const rows: RendererDiffRow[] = [];
    for (const p of pro) {
      const s = srcById.get(p.id);
      rows.push({
        id: p.id,
        kind: !s ? "added" : sameRow(p, s) ? "unchanged" : "changed",
        label: rowLabel(name, p),
      });
    }
    for (const s of src) {
      if (!proIds.has(s.id)) {
        rows.push({ id: s.id, kind: "removed", label: rowLabel(name, s) });
      }
    }
    return {
      name,
      added: rows.filter((r) => r.kind === "added").length,
      changed: rows.filter((r) => r.kind === "changed").length,
      removed: rows.filter((r) => r.kind === "removed").length,
      rows,
    };
  });
  const metaChanged: string[] = [];
  for (const k of ["meta", "goal", "kr", "solution", "risks"] as const) {
    if (
      JSON.stringify(proposal[k] ?? null) !==
      JSON.stringify(source[k] ?? null)
    ) {
      metaChanged.push(k);
    }
  }
  return { sections, metaChanged };
}

/* ------------------------------------------------------------------ *
 * validateRenderer                                                    *
 * ------------------------------------------------------------------ */

/**
 * Parse + validate a model answer into a proposal. `proposal` is null
 * only when no canvas block exists or the body fails the schema gate —
 * error-severity issues stay attached either way so the preview can show
 * exactly what failed, and apply refuses while any remain.
 */
export function validateRenderer(
  text: string,
  source: CanvasBody,
): RendererPreview {
  const issues: RendererIssue[] = [];
  const md = extractCanvasMarkdown(text);
  if (md === null) {
    issues.push({
      severity: "error",
      code: "RENDER_NO_CANVAS",
      path: "document",
      message:
        "Kết quả AI không chứa canvas Markdown theo khung canonical — không tạo đề xuất.",
      id: "",
    });
    issues[0]!.id = issueId(issues[0]!);
    return { kind: "renderer", proposal: null, issues, diff: null, previewHash: "" };
  }
  const parsed = parseMarkdown(md);
  for (const i of parsed.issues) {
    issues.push({ ...i, id: issueId(i) });
  }
  if (!parsed.body) {
    issues.push({
      severity: "error",
      code: "RENDER_SCHEMA_INVALID",
      path: "document",
      message: "Canvas đề xuất không qua được schema 3.0 — không tạo đề xuất.",
      id: "",
    });
    const last = issues[issues.length - 1]!;
    last.id = issueId(last);
    return { kind: "renderer", proposal: null, issues, diff: null, previewHash: "" };
  }
  const proposal = parsed.body;
  remapStableIds(proposal, source);
  for (const i of rendererChecks(proposal, source)) {
    issues.push({ ...i, id: issueId(i) });
  }
  const diff = diffBodies(proposal, source);
  const previewHash = createHash("sha256")
    .update(JSON.stringify({ proposal, issues }))
    .digest("hex");
  return { kind: "renderer", proposal, issues, diff, previewHash };
}

/* ------------------------------------------------------------------ *
 * Service: driver + apply                                             *
 * ------------------------------------------------------------------ */

export function createRendererService({
  db,
  clock,
  config,
  runs,
}: {
  db: Knex;
  clock: Clock;
  config: Config;
  runs: AiRunsService;
}) {
  const policy = createPolicy(db);
  const canvas = createCanvasService({ db, policy, clock });

  function loadPrompt(): { text: string; version: string } {
    const dir = resolve("server/prompts/renderer");
    const manifest = JSON.parse(
      readFileSync(resolve(dir, "manifest.json"), "utf8"),
    ) as { promptVersion: string; sha256: string };
    const text = readFileSync(resolve(dir, "instruction.md"), "utf8");
    const sha = createHash("sha256").update(text).digest("hex");
    if (sha !== manifest.sha256) {
      // A prompt that drifted from its reviewed manifest must never run —
      // fail closed rather than silently executing an unvetted template.
      throw new AppError(
        500,
        "AI_INTERNAL",
        "Prompt renderer lệch manifest — từ chối chạy",
      );
    }
    return { text, version: manifest.promptVersion };
  }

  /**
   * The run driver registered on the runs service. Reads the current
   * draft body through the canvas service (real authorization), renders
   * it to canonical Markdown as the v1 context, asks the model for the
   * updated canvas, validates, and stages the result as the run's
   * preview. Raw input/output never touches the DB or logs.
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
    const detail = await canvas.getCanvas(actor, run.canvas_id);
    const source =
      detail.draft?.body ??
      (run.base_version_id
        ? (
            await canvas.getVersion(
              actor,
              run.canvas_id,
              run.base_version_id,
            )
          ).body
        : null);
    if (!source) {
      throw new AppError(
        409,
        "AI_BASE_CHANGED",
        "Canvas chưa có nội dung để AI cập nhật",
      );
    }
    return finish(source);

    async function finish(src: CanvasBody): Promise<RunDriverResult> {
      const v1md = toMarkdown(src).text;
      const userContent =
        `## Canvas hiện tại (v1)\n\n${v1md}\n\n` +
        `## Dữ liệu phiên\n\n${input.notes?.trim() || "(không có ghi chú)"}`;
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
      const preview = validateRenderer(result.text, src);
      return {
        preview,
        usage: result.usage,
        promptVersion: prompt.version,
      };
    }
  };

  /**
   * Apply a staged renderer proposal to the canvas draft. The proposal
   * comes from the server's preview store — the request carries only the
   * captured revision the user reviewed plus accepted warning ids.
   *
   * Order (pinned): run ownership/state → preview → captured-base
   * re-check → warnings coverage → saveDraft (which re-checks permission,
   * revision and base under the company lock). AI never publishes.
   */
  async function apply(
    actor: ActorContext,
    runId: string,
    input: { expectedRevision: number | null; acceptedWarnings: string[] },
  ): Promise<DraftDto> {
    const run = await runs.loadOwnedRun(actor, runId);
    if (run.assistant !== "renderer") {
      throw new AppError(400, "INVALID_INPUT", "Run không phải renderer");
    }
    if (run.status !== "succeeded") {
      throw new AppError(
        409,
        AI_RUN_NOT_READY,
        "Run chưa hoàn thành — chưa có đề xuất để áp dụng",
      );
    }
    const stored = await runs.getPreview(actor, runId);
    const preview = stored.value as RendererPreview;
    if (preview.kind !== "renderer" || !preview.proposal) {
      throw new AppError(409, AI_PROPOSAL_INVALID, "Đề xuất không hợp lệ");
    }
    const errors = preview.issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new AppError(
        409,
        AI_PROPOSAL_INVALID,
        "Đề xuất còn lỗi — không thể áp dụng, hãy chạy lại",
        { count: errors.length },
      );
    }
    const warnings = preview.issues.filter((i) => i.severity === "warning");
    const missing = warnings
      .map((w) => w.id)
      .filter((id) => !input.acceptedWarnings.includes(id));
    if (missing.length > 0) {
      throw new AppError(
        400,
        AI_WARNINGS_UNACCEPTED,
        "Còn cảnh báo chưa được xác nhận trước khi áp dụng",
        { missing },
      );
    }

    // The request's expectedRevision must equal what the preview was
    // captured against — passing a newer revision cannot skip the base
    // check, and a stale one means the user reviewed something else.
    if (input.expectedRevision !== stored.base.draftRevision) {
      throw new AppError(
        409,
        AI_BASE_CHANGED,
        "Canvas đã thay đổi; hãy so sánh lại",
      );
    }
    const liveCanvas = await findCanvasById(db, actor.companyId, run.canvas_id);
    const liveDraft = await findDraftByCanvas(db, actor.companyId, run.canvas_id);
    if (
      (liveCanvas?.current_version_id ?? null) !== stored.base.baseVersionId ||
      (liveDraft?.revision ?? null) !== stored.base.draftRevision
    ) {
      throw new AppError(
        409,
        AI_BASE_CHANGED,
        "Canvas đã thay đổi; hãy so sánh lại",
      );
    }

    if (liveDraft === undefined) {
      // No draft at capture and none now: create it carrying the proposal
      // (base = captured published version, still current per the check).
      return canvas.createDraft(actor, run.canvas_id, {
        body: preview.proposal,
        source: "ai",
        aiRunId: runId,
      });
    }
    const dto = await canvas.saveDraft(actor, run.canvas_id, {
      expectedRevision: stored.base.draftRevision!,
      baseVersionId: stored.base.baseVersionId,
      body: preview.proposal,
      source: "ai",
      aiRunId: runId,
    });
    runs.previews.take(runId); // one-shot: applied previews are consumed
    return dto;
  }

  return { driver, apply };
}

export type RendererService = ReturnType<typeof createRendererService>;
