import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { rateLimit } from "../../shared/rate-limit.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import {
  aiSettingsPutSchema,
  aiRunStartSchema,
  aiRunApplySchema,
} from "./schema.js";
import { createAiSettingsService } from "./settings.js";
import {
  createAiRunsService,
  AI_RUN_FINISHED,
  type AiAssistant,
  type AiRunEvent,
  type AiRunsService,
  type RunDriver,
} from "./runs.js";
import { createRendererService } from "./renderer.js";
import { createCoachService } from "./coach.js";
import { createOracleService } from "../coaching/grader.js";
import { createCoachingService } from "../coaching/service.js";
import { createPolicy } from "../authorization/policy.js";

/**
 * /api/v1 AI surface (task 3.1, spec §7.1):
 *
 *   GET    /settings/ai      — owner/admin only; public shape (configured,
 *                              enabled, endpoint, model, bounds) — NEVER the
 *                              key or its envelope.
 *   PUT    /settings/ai      — owner/admin only; strict body; baseUrl must
 *                              be inside the operator AI_ALLOWED_HOSTS
 *                              allowlist; apiKey absent preserves the stored
 *                              key. Rate-limited per client IP — key/config
 *                              writes are low-frequency admin operations.
 *   GET    /ai/status        — any signed-in user; {configured, enabled}
 *                              only — no endpoint/model/key detail.
 *   DELETE /settings/ai/key  — owner/admin only; explicit credential clear.
 *                              Kept separate from PUT so an omitted field can
 *                              never wipe a key by accident.
 *
 * Bearer-token mutations need requireAuth only — the Origin/CSRF gates
 * protect cookie-bearing session endpoints, not Bearer calls (spec §8).
 */
function actorOf(res: Response): ActorContext {
  return res.locals.actor as ActorContext;
}

function parseBody<T>(
  schema: {
    safeParse: (v: unknown) => {
      success: boolean;
      data?: T;
      error?: { issues: { path: PropertyKey[] }[] };
    };
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, "INVALID_INPUT", "Dữ liệu không hợp lệ", {
      fields: parsed.error!.issues.map((i) => i.path.join(".")),
    });
  }
  return parsed.data as T;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that cannot be a uuid is a nonexistent resource → 404. */
function pathId(raw: string | string[]): string {
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
  }
  return id;
}

export function aiRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
  /**
   * Driver override for tests: when given, ONLY these drivers are
   * registered — an empty object keeps every run queued forever so
   * lifecycle tests can observe the state machine deterministically.
   */
  drivers?: Partial<Record<AiAssistant, RunDriver>>;
  /**
   * Shared runs service (app.ts creates ONE so the preview store is the
   * same instance saveReport reads — task 4.2). Tests that omit it get a
   * private instance; standalone routers stay self-contained.
   */
  runs?: AiRunsService;
}): Router {
  const { db, clock, config } = deps;
  const auth = createAuthService({ db, clock, config });
  const ai = createAiSettingsService({ db, clock, config });
  const aiRuns = deps.runs ?? createAiRunsService({ db, clock, config });
  const coaching = createCoachingService({
    db,
    policy: createPolicy(db),
    clock,
    runs: aiRuns,
  });
  const renderer = createRendererService({ db, clock, config, runs: aiRuns });
  const coach = createCoachService({ db, clock, config, runs: aiRuns });
  const oracle = createOracleService({ db, clock, config, runs: aiRuns });
  const drivers = deps.drivers ?? {
    renderer: renderer.driver,
    coach: coach.driver,
    oracle: oracle.driver,
  };
  for (const [assistant, driver] of Object.entries(drivers)) {
    aiRuns.registerDriver(assistant as AiAssistant, driver);
  }
  const router = Router();

  // Config writes are rare admin operations — a tight per-IP bound is
  // enough headroom and blocks scripted probing of the key path.
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 10 });

  router.get(
    "/settings/ai",
    requireAuth(auth),
    async (_req: Request, res: Response) => {
      res.json(await ai.getAiSettings(actorOf(res)));
    },
  );

  // Any signed-in user: {configured, enabled} only — lets every AI surface
  // explain "not configured / disabled" BEFORE consent (spec §7.1).
  router.get(
    "/ai/status",
    requireAuth(auth),
    async (_req: Request, res: Response) => {
      res.json(await ai.getAiStatus(actorOf(res)));
    },
  );

  router.put(
    "/settings/ai",
    requireAuth(auth),
    writeLimiter,
    async (req: Request, res: Response) => {
      const body = parseBody(aiSettingsPutSchema, req.body);
      res.json(await ai.saveAiSettings(actorOf(res), body));
    },
  );

  router.delete(
    "/settings/ai/key",
    requireAuth(auth),
    writeLimiter,
    async (_req: Request, res: Response) => {
      res.json(await ai.clearAiKey(actorOf(res)));
    },
  );

  // Connection probe — synthetic prompt only, hits the configured upstream.
  // Tight per-IP bound: this invokes the external endpoint every call.
  const probeLimiter = rateLimit({ windowMs: 60_000, max: 5 });
  router.post(
    "/settings/ai/test",
    requireAuth(auth),
    probeLimiter,
    async (_req: Request, res: Response) => {
      res.json(await ai.testConnection(actorOf(res)));
    },
  );

  /* ------------------------------------------------------------------
   * Runs (task 3.3): consented start, idempotent replay, SSE progress,
   * cancel, and the 15-minute preview read.
   * ------------------------------------------------------------------ */

  // Runs are interactive user operations — a looser bound than config
  // writes, but still capped so scripted run-spam can't exhaust the
  // per-company concurrency window.
  const runLimiter = rateLimit({ windowMs: 60_000, max: 30 });

  router.post(
    "/ai/runs",
    requireAuth(auth),
    runLimiter,
    async (req: Request, res: Response) => {
      const body = parseBody(aiRunStartSchema, req.body);
      const actor = actorOf(res);
      const started = await aiRuns.startRun(actor, body);
      // The dispatcher is fire-and-forget: the run row is the durable
      // record, the client follows progress on /events. A run whose
      // assistant has no registered driver simply stays queued.
      if (!started.replayed) {
        // Notes/transcript live only for this request+run — the dispatch
        // closure holds them in memory until the driver returns; neither
        // is persisted anywhere (spec §6).
        let sessionNotes: string | undefined;
        if (body.reportId !== undefined) {
          // The bridge re-reads the report under BOTH ACLs (report read ∧
          // canvas write) and extracts only the whitelisted fields — the
          // client cannot push report content into the prompt directly.
          const bridge = await coaching.loadReportForRenderer(
            actor,
            body.reportId,
            body.canvasId as string,
            body.reportFields,
          );
          sessionNotes = bridge.sessionNotes;
        }
        void aiRuns
          .dispatch(started.runId, actor.companyId, {
            notes: body.notes,
            transcript: body.transcript,
            sessionNotes,
          })
          .catch(() => {});
      }
      res.status(started.replayed ? 200 : 201).json(started);
    },
  );

  router.get(
    "/ai/runs/:runId",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(await aiRuns.getRun(actorOf(res), pathId(req.params.runId)));
    },
  );

  router.get(
    "/ai/runs/:runId/preview",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const runId = pathId(req.params.runId);
      const p = await aiRuns.getPreview(actorOf(res), runId);
      res.json({ runId, base: p.base, value: p.value });
    },
  );

  router.post(
    "/ai/runs/:runId/cancel",
    requireAuth(auth),
    runLimiter,
    async (req: Request, res: Response) => {
      res.json(await aiRuns.cancelRun(actorOf(res), pathId(req.params.runId)));
    },
  );

  /**
   * Apply the staged renderer proposal to the canvas draft. The request
   * carries no body — the server applies what IT validated (spec §7.3:
   * AI output is previewed and explicitly applied, never trusted from
   * the client). Permission + captured base are re-checked inside.
   */
  router.post(
    "/ai/runs/:runId/apply",
    requireAuth(auth),
    runLimiter,
    async (req: Request, res: Response) => {
      const body = parseBody(aiRunApplySchema, req.body);
      res.json(
        await renderer.apply(actorOf(res), pathId(req.params.runId), body),
      );
    },
  );

  /**
   * SSE progress stream (spec §7.3). Events: {type:"status"|"delta"|
   * "done"|"error"}. A client disconnect cancels a still-active run —
   * spec: "Disconnect phải dừng run upstream khi có thể" — runs never
   * continue consuming upstream capacity after the caller is gone.
   */
  router.get(
    "/ai/runs/:runId/events",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const actor = actorOf(res);
      const runId = pathId(req.params.runId);
      // Ownership gate before any bytes go out — foreign runs are 404.
      const run = await aiRuns.loadOwnedRun(actor, runId);

      res.status(200);
      res.setHeader("content-type", "text/event-stream; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();

      let closed = false;
      const send = (e: AiRunEvent): void => {
        if (closed) return;
        res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (e.type === "done" || e.type === "error") {
          closed = true;
          res.end();
        }
      };
      const unsubscribe = aiRuns.subscribe(runId, send);
      // Current status first, so a late subscriber sees where it is.
      send({ type: "status", status: run.status });
      if (run.status !== "queued" && run.status !== "running") {
        closed = true;
        res.end();
      }

      req.on("close", () => {
        unsubscribe();
        if (closed) return;
        closed = true;
        // The client went away mid-run → stop the run (upstream abort
        // happens through the run's AbortController).
        void aiRuns
          .cancelRun(actor, runId)
          .catch((err) => {
            if (!(err instanceof AppError && err.code === AI_RUN_FINISHED)) {
              throw err;
            }
          })
          .catch(() => {});
      });
    },
  );

  return router;
}
