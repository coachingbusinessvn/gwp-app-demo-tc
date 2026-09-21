import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { keysetCursorParam, pageLimit } from "../../shared/pagination.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import { createPolicy } from "../authorization/policy.js";
import type { AiRunsService } from "../ai/runs.js";
import { createCoachingService } from "./service.js";
import {
  createSessionBodySchema,
  deleteReportBodySchema,
  saveReportBodySchema,
} from "./schema.js";

/**
 * /api/v1 coaching surface (task 4.1, spec §6):
 *
 *   POST /coaching-sessions             — record a session (self-coach, or
 *                                         owner on behalf — audited)
 *   GET  /reports                       — report list scoped by report ACL
 *   GET  /reports/:id                   — one report; authorized reads audited
 *   POST /reports                       — explicit save from a validated
 *                                         grader preview (task 4.2)
 *   PUT    /reports/:id/shares/:userId  — grant a same-company read share
 *   DELETE /reports/:id/shares/:userId  — revoke it (next request denies)
 *   DELETE /reports/:id  {confirm:true} — delete body+shares (task 4.3)
 *
 * Report rights come only from the report ACL — never from canvas access
 * or the reporting tree (spec §6). Handlers stay thin: parse → service.
 * Share/delete are coach-of-record or owner only — a sharee reads but
 * never re-shares, and an on-behalf creator holds no grant rights. There
 * is deliberately no session update/delete route (sessions are records
 * of fact).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** A path id that cannot be a uuid is a nonexistent resource → 404. */
function pathId(raw: string | string[]): string {
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
  }
  return id;
}

/** Optional uuid query filter — malformed values are 400, not silent. */
function uuidQueryParam(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  const v = typeof raw === "string" ? raw : "";
  if (!UUID_RE.test(v)) {
    throw new AppError(400, "INVALID_INPUT", "Dữ liệu không hợp lệ", {
      fields: [name],
    });
  }
  return v;
}

export function coachingRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
  /** Shared AI runs service — owns the preview store saveReport reads. */
  runs: AiRunsService;
}): Router {
  const { db, clock, config, runs } = deps;
  const auth = createAuthService({ db, clock, config });
  const coaching = createCoachingService({
    db,
    policy: createPolicy(db),
    clock,
    runs,
  });
  const router = Router();

  router.post(
    "/coaching-sessions",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(createSessionBodySchema, req.body);
      const created = await coaching.createSession(actorOf(res), body);
      res.status(201).json(created);
    },
  );

  /**
   * Save the validated grader preview as an immutable report version.
   * The body is taken from the SERVER's preview for the run — the request
   * identifies it, it cannot supply content (spec §6/§7.3).
   */
  router.post(
    "/reports",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(saveReportBodySchema, req.body);
      const saved = await coaching.saveReport(actorOf(res), body);
      const { replayed, ...dto } = saved;
      res.status(replayed ? 200 : 201).json(dto);
    },
  );

  router.get(
    "/reports",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await coaching.listReports(actorOf(res), {
          limit: pageLimit(req.query.limit),
          cursor: keysetCursorParam(req.query.cursor),
          coacheeUserId: uuidQueryParam(req.query.coacheeUserId, "coacheeUserId"),
        }),
      );
    },
  );

  router.get(
    "/reports/:id",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(await coaching.getReport(actorOf(res), pathId(req.params.id)));
    },
  );

  /**
   * Explicit per-version share grants (task 4.3). PUT upserts the grant —
   * sharing twice or re-sharing after revoke just re-activates the row.
   */
  router.put(
    "/reports/:id/shares/:userId",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await coaching.shareReport(
          actorOf(res),
          pathId(req.params.id),
          pathId(req.params.userId),
        ),
      );
    },
  );

  router.delete(
    "/reports/:id/shares/:userId",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      await coaching.revokeShare(
        actorOf(res),
        pathId(req.params.id),
        pathId(req.params.userId),
      );
      res.status(204).end();
    },
  );

  /** Confirmed delete: body must be exactly {confirm:true} (spec §6). */
  router.delete(
    "/reports/:id",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      parseBody(deleteReportBodySchema, req.body ?? {});
      await coaching.deleteReport(actorOf(res), pathId(req.params.id));
      res.status(204).end();
    },
  );

  return router;
}
