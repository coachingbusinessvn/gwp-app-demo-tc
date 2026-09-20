import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { keysetCursorParam, pageLimit } from "../../shared/pagination.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import { listAuditEvents } from "./service.js";

/**
 * /api/v1 audit surface (task 1.5, spec §4/§9):
 *
 *   GET /audit?limit&cursor — owner/admin only; metadata-only rows
 *   (id, at, actorId, action, outcome, requestId, targetType/targetId and
 *   allowlisted safe_metadata), newest-first keyset pagination. There is
 *   deliberately no way to read a raw audit row or any content payload.
 *
 * The cursor is the shared keysetCursorParam (task 2.4): the timestamp half
 * is Postgres-rendered µs ISO passed back to ::timestamptz verbatim, and
 * impossible calendar dates (JS Date normalizes them, e.g. 2026-02-31 →
 * Mar 3, then Postgres throws 22008) are rejected up front as 400.
 */
function actorOf(res: Response): ActorContext {
  return res.locals.actor as ActorContext;
}

export function auditRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { db, clock, config } = deps;
  const auth = createAuthService({ db, clock, config });
  const router = Router();

  router.get(
    "/audit",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await listAuditEvents(db, actorOf(res), {
          limit: pageLimit(req.query.limit),
          cursor: keysetCursorParam(req.query.cursor),
        }),
      );
    },
  );

  return router;
}
