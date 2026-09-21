import { createHash, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { appendAudit } from "../audit/service.js";
import { createCanvasService } from "../canvas/service.js";
import {
  findCanvasById,
  findDraftByCanvas,
} from "../canvas/repository.js";
import { createPolicy } from "../authorization/policy.js";
import {
  assertSessionWrite,
  findSession,
} from "../coaching/policy.js";
import { createAiSettingsService, type AiRuntimeConfig } from "./settings.js";
import { createPreviewStore, type PreviewStore } from "./preview.js";

/**
 * AI run lifecycle (task 3.3, spec §7.3): consented, idempotent, bounded.
 *
 * - `ai_run` rows carry METADATA ONLY — status, timestamps, input hash,
 *   provenance (model/key/prompt versions), captured canvas base. User
 *   notes and canvas content are hashed into input_hash and never stored;
 *   the proposal itself lives only in the 15-minute in-memory preview.
 * - Admission is serialized on the company lock: at most 2 active
 *   (queued|running) runs per company, no waiting queue.
 * - Idempotency: (company, actor, assistant, key) is unique; same key +
 *   same input hash replays the existing run, different input → 409.
 * - A run belongs to its creator: get/events/cancel answer 404 to anyone
 *   else, and an events-stream disconnect cancels the run (spec: a
 *   disconnect must stop the upstream call when possible).
 * - Drivers (renderer in 3.4, coach in 3.5) register per assistant and
 *   receive {emit, signal, config}; the service owns status transitions,
 *   cancellation and the interrupt sweep on boot.
 */

export const AI_CONSENT_REQUIRED = "AI_CONSENT_REQUIRED";
export const AI_IDEMPOTENCY_CONFLICT = "AI_IDEMPOTENCY_CONFLICT";
export const AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED";
export const AI_DISABLED = "AI_DISABLED";
export const AI_RUN_BUSY = "AI_BUSY";
export const AI_RUN_FINISHED = "AI_RUN_FINISHED";

/** spec §7.3 pilot bound: 2 concurrent AI runs per company, no queue. */
export const AI_MAX_ACTIVE_RUNS = 2;

export type AiAssistant = "renderer" | "coach" | "oracle";
export type AiRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AiRunRow {
  id: string;
  company_id: string;
  actor_id: string;
  assistant: AiAssistant;
  /** Set for canvas assistants (renderer/coach); NULL on oracle runs. */
  canvas_id: string | null;
  /** Set for oracle runs (task 4.2); NULL on canvas runs. */
  session_id: string | null;
  status: AiRunStatus;
  input_hash: string;
  base_version_id: string | null;
  captured_draft_revision: number | null;
  prompt_version: string | null;
  config_key_version: string | null;
  config_model: string | null;
  error_code: string | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  request_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

export interface AiRunDto {
  runId: string;
  assistant: AiAssistant;
  canvasId: string | null;
  sessionId: string | null;
  status: AiRunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface AiRunEvent {
  type: "status" | "delta" | "done" | "error";
  status?: AiRunStatus;
  text?: string;
  code?: string;
}

export interface RunDriverResult {
  /** When set, the result is staged into the bounded preview store. */
  preview?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  /** Versioned prompt id recorded on the run row for provenance. */
  promptVersion?: string;
}

export type RunDriver = (ctx: {
  run: AiRunRow;
  actor: ActorContext;
  emit: (e: AiRunEvent) => void;
  signal: AbortSignal;
  config: AiRuntimeConfig;
  /**
   * Request-scoped input passed through dispatch — notes and transcripts
   * exist only for the request+run lifetime, matching the
   * no-raw-input-persistence rule (spec §6: transcripts are never stored).
   */
  input: { notes?: string; transcript?: string };
}) => Promise<RunDriverResult>;

function toDto(r: AiRunRow): AiRunDto {
  return {
    runId: r.id,
    assistant: r.assistant,
    canvasId: r.canvas_id,
    sessionId: r.session_id,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    errorCode: r.error_code,
    usage:
      r.usage_input_tokens !== null && r.usage_output_tokens !== null
        ? {
            inputTokens: r.usage_input_tokens,
            outputTokens: r.usage_output_tokens,
          }
        : null,
  };
}

function notFound(): AppError {
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

export function createAiRunsService({
  db,
  clock,
  config,
  previewStore,
}: {
  db: Knex;
  clock: Clock;
  config: Config;
  previewStore?: PreviewStore;
}) {
  const policy = createPolicy(db);
  const canvas = createCanvasService({ db, policy, clock });
  const aiSettings = createAiSettingsService({ db, clock, config });
  const previews = previewStore ?? createPreviewStore();

  const drivers = new Map<AiAssistant, RunDriver>();
  const activeControllers = new Map<string, AbortController>();
  const subscribers = new Map<string, Set<(e: AiRunEvent) => void>>();

  function emit(runId: string, e: AiRunEvent): void {
    for (const fn of subscribers.get(runId) ?? []) {
      try {
        fn(e);
      } catch {
        // A broken subscriber must not break the run.
      }
    }
  }

  async function loadRun(
    companyId: string,
    runId: string,
  ): Promise<AiRunRow | undefined> {
    return (await db("ai_run")
      .where({ company_id: companyId, id: runId })
      .first()) as AiRunRow | undefined;
  }

  /** Only the run's creator may see/touch it — everyone else gets 404. */
  async function loadOwnedRun(
    actor: ActorContext,
    runId: string,
  ): Promise<AiRunRow> {
    const run = await loadRun(actor.companyId, runId);
    if (!run || run.actor_id !== actor.userId) throw notFound();
    return run;
  }

  /**
   * Admission (serialized on the company lock):
   * consent → canvas write access → idempotency → concurrency cap →
   * capture base snapshot + config provenance → insert queued.
   */
  async function startRun(
    actor: ActorContext,
    input: {
      assistant: AiAssistant;
      canvasId?: string;
      /** Oracle runs bind a coaching session, not a canvas (task 4.2). */
      sessionId?: string;
      /** Oracle input — hashed into input_hash, never persisted. */
      transcript?: string;
      notes?: string;
      consent?: boolean;
      idempotencyKey: string;
    },
  ): Promise<{ runId: string; status: AiRunStatus; replayed: boolean }> {
    let replayed = false;
    let finalStatus: AiRunStatus = "queued";
    if (input.consent !== true) {
      throw new AppError(
        400,
        AI_CONSENT_REQUIRED,
        "Cần đồng ý xử lý nội dung bằng AI nội bộ trước khi chạy",
      );
    }
    // The input hash is the ONLY trace of notes/transcript — content
    // never persists anywhere in the database, logs or audit (spec §6).
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify({
          assistant: input.assistant,
          canvasId: input.canvasId ?? null,
          sessionId: input.sessionId ?? null,
          notes: input.notes ?? "",
          transcript: input.transcript ?? "",
        }),
      )
      .digest("hex");

    const cfg = await aiSettings.loadAiConfig(actor.companyId);
    if (!cfg) {
      throw new AppError(
        503,
        AI_NOT_CONFIGURED,
        "Chưa cấu hình endpoint/key AI",
      );
    }
    if (!cfg.enabled) {
      throw new AppError(409, AI_DISABLED, "AI đang tắt trong settings");
    }

    const runId = await db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      if (input.assistant === "oracle") {
        // Session-scoped run (task 4.2): the actor needs report-write
        // authority on the session — owner, or the session's coach who
        // STILL manages the coachee. Same gate saveReport re-checks.
        if (!input.sessionId) {
          throw new AppError(400, "INVALID_INPUT", "Thiếu sessionId");
        }
        const session = await findSession(tx, actor.companyId, input.sessionId);
        if (!session) throw notFound();
        await assertSessionWrite(tx, actor, session);
      } else {
        // Write access because renderer/coach act on the actor's canvas
        // scope (spec §4 "Chạy AI trên canvas — theo quyền sửa"); also the
        // uniform 404 for foreign/denied canvases and 409 on archived.
        if (!input.canvasId) {
          throw new AppError(400, "INVALID_INPUT", "Thiếu canvasId");
        }
        await canvas.assertWrite(actor, input.canvasId, tx);
      }

      const existing = (await tx("ai_run")
        .where({
          company_id: actor.companyId,
          actor_id: actor.userId,
          assistant: input.assistant,
          idempotency_key: input.idempotencyKey,
        })
        .first()) as AiRunRow | undefined;
      if (existing) {
        if (existing.input_hash === inputHash) {
          replayed = true;
          finalStatus = existing.status;
          return existing.id;
        }
        throw new AppError(
          409,
          AI_IDEMPOTENCY_CONFLICT,
          "idempotencyKey đã dùng với nội dung khác",
        );
      }

      const [{ count }] = (await tx("ai_run")
        .where({ company_id: actor.companyId })
        .whereIn("status", ["queued", "running"])
        .count("* as count")) as { count: string }[];
      if (Number(count) >= AI_MAX_ACTIVE_RUNS) {
        throw new AppError(
          429,
          AI_RUN_BUSY,
          "Đã đạt giới hạn 2 run AI đồng thời — thử lại sau",
        );
      }

      // Base snapshot: the canvas's published pointer + live draft
      // revision at admission — apply (3.4) refuses a moved target.
      // Oracle runs carry neither (they grade a session, not a canvas).
      const canvasRow = input.canvasId
        ? await findCanvasById(tx, actor.companyId, input.canvasId)
        : undefined;
      const draft = input.canvasId
        ? await findDraftByCanvas(tx, actor.companyId, input.canvasId)
        : undefined;

      const id = randomUUID();
      await tx("ai_run").insert({
        id,
        company_id: actor.companyId,
        actor_id: actor.userId,
        assistant: input.assistant,
        canvas_id: input.canvasId ?? null,
        session_id: input.sessionId ?? null,
        status: "queued",
        idempotency_key: input.idempotencyKey,
        input_hash: inputHash,
        consent_at: clock(),
        base_version_id: canvasRow?.current_version_id ?? null,
        captured_draft_revision: draft?.revision ?? null,
        config_key_version: cfg.keyVersion,
        config_model: cfg.model,
        request_id: actor.requestId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "ai.run.start",
        targetType: "ai_run",
        targetId: id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: {
          assistant: input.assistant,
          model: cfg.model,
          key_version: cfg.keyVersion,
        },
      });
      return id;
    });

    return { runId, status: finalStatus, replayed };
  }

  /** Register the per-assistant executor (renderer 3.4, coach 3.5). */
  function registerDriver(assistant: AiAssistant, driver: RunDriver): void {
    drivers.set(assistant, driver);
  }

  /**
   * Drive a queued run to completion. Fire-and-forget from the route —
   * the run row is the durable record, the events bus streams progress.
   * A missing driver leaves the run queued (3.4/3.5 plug in).
   */
  async function dispatch(
    runId: string,
    companyId: string,
    input: { notes?: string; transcript?: string } = {},
  ): Promise<void> {
    const run = await loadRun(companyId, runId);
    if (!run || run.status !== "queued") return;
    const driver = drivers.get(run.assistant);
    if (!driver) return;
    const claimed = await db("ai_run")
      .where({ id: runId, status: "queued" })
      .update({ status: "running", started_at: clock() });
    if (claimed !== 1) return;
    emit(runId, { type: "status", status: "running" });
    const controller = new AbortController();
    activeControllers.set(runId, controller);
    const cfg = await aiSettings.loadAiConfig(companyId);
    try {
      if (!cfg) throw new AppError(503, AI_NOT_CONFIGURED, "Mất cấu hình AI");
      const result = await driver({
        run,
        actor: {
          userId: run.actor_id,
          companyId: run.company_id,
          sessionId: "",
          requestId: run.id,
        },
        emit: (e) => emit(runId, e),
        signal: controller.signal,
        config: cfg,
        input,
      });
      // CAS: a cancel that raced ahead already wrote 'cancelled' — a
      // late success must not overwrite the terminal state.
      const wrote = await db("ai_run")
        .where({ id: runId, status: "running" })
        .update({
          status: "succeeded",
          finished_at: clock(),
          prompt_version: result.promptVersion ?? run.prompt_version,
          usage_input_tokens: result.usage?.inputTokens ?? null,
          usage_output_tokens: result.usage?.outputTokens ?? null,
        });
      if (wrote === 1 && result.preview !== undefined) {
        previews.put({
          runId,
          actorId: run.actor_id,
          companyId,
          value: result.preview,
          base: {
            baseVersionId: run.base_version_id,
            draftRevision: run.captured_draft_revision,
          },
        });
      }
      if (wrote === 1) emit(runId, { type: "status", status: "succeeded" });
      emit(runId, { type: "done" });
    } catch (err) {
      const cancelled =
        controller.signal.aborted ||
        (err instanceof AppError && err.code === "AI_CANCELLED");
      const code =
        err instanceof AppError ? err.code : "AI_INTERNAL";
      const wrote = await db("ai_run")
        .where({ id: runId, status: "running" })
        .update({
          status: cancelled ? "cancelled" : "failed",
          finished_at: clock(),
          error_code: cancelled ? "AI_CANCELLED" : code,
        });
      if (wrote === 1) {
        emit(runId, {
          type: "status",
          status: cancelled ? "cancelled" : "failed",
        });
      }
      emit(runId, { type: "error", code: cancelled ? "AI_CANCELLED" : code });
    } finally {
      activeControllers.delete(runId);
    }
  }

  async function getRun(actor: ActorContext, runId: string): Promise<AiRunDto> {
    return toDto(await loadOwnedRun(actor, runId));
  }

  async function cancelRun(
    actor: ActorContext,
    runId: string,
  ): Promise<AiRunDto> {
    const run = await loadOwnedRun(actor, runId);
    if (run.status !== "queued" && run.status !== "running") {
      throw new AppError(
        409,
        AI_RUN_FINISHED,
        "Run đã kết thúc — không thể hủy",
      );
    }
    // Abort first so a running driver unwinds; the row update is the
    // terminal record and wins against a racing completion via CAS.
    activeControllers.get(runId)?.abort();
    const wrote = await db.transaction(async (tx) => {
      const n = await tx("ai_run")
        .where({ id: runId, company_id: actor.companyId })
        .whereIn("status", ["queued", "running"])
        .update({ status: "cancelled", finished_at: clock() });
      if (n === 1) {
        await appendAudit(tx, {
          companyId: actor.companyId,
          actorId: actor.userId,
          action: "ai.run.cancel",
          targetType: "ai_run",
          targetId: runId,
          outcome: "success",
          requestId: actor.requestId,
          metadata: { assistant: run.assistant, status: "cancelled" },
        });
      }
      return n;
    });
    if (wrote === 1) emit(runId, { type: "status", status: "cancelled" });
    emit(runId, { type: "done" });
    return toDto((await loadRun(actor.companyId, runId))!);
  }

  /**
   * Events stream state for one subscriber set — the run creator only.
   * The handler owns SSE framing; this just manages the subscription.
   */
  function subscribe(runId: string, fn: (e: AiRunEvent) => void): () => void {
    let set = subscribers.get(runId);
    if (!set) subscribers.set(runId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) subscribers.delete(runId);
    };
  }

  /**
   * Read the run's preview — creator only (404 for others); expired or
   * missing → 410. Returns the stored value plus the captured base.
   */
  async function getPreview(
    actor: ActorContext,
    runId: string,
  ): Promise<{
    value: unknown;
    base: { baseVersionId: string | null; draftRevision: number | null };
  }> {
    await loadOwnedRun(actor, runId);
    const e = previews.get(runId);
    if (e.actorId !== actor.userId || e.companyId !== actor.companyId) {
      // Same 410 as a missing preview — existence is not revealed.
      throw new AppError(
        410,
        "PREVIEW_EXPIRED",
        "Preview đã hết hạn — hãy chạy AI lại",
      );
    }
    return { value: e.value, base: e.base };
  }

  /**
   * Boot sweep (spec §7.3): queued/running rows from a dead process become
   * 'interrupted' — never retried silently, never holding a slot forever.
   */
  async function markInterruptedRuns(): Promise<number> {
    const n = await db("ai_run")
      .whereIn("status", ["queued", "running"])
      .update({ status: "interrupted", finished_at: clock() });
    return Number(n);
  }

  return {
    startRun,
    getRun,
    cancelRun,
    getPreview,
    loadOwnedRun,
    subscribe,
    dispatch,
    registerDriver,
    markInterruptedRuns,
    previews,
  };
}

export type AiRunsService = ReturnType<typeof createAiRunsService>;
