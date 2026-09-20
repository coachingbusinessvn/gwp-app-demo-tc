import { Router, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import { createPolicy } from "../authorization/policy.js";
import { createDashboardService } from "./service.js";

/**
 * /api/v1 dashboard surface (task 2.6, spec §5.3):
 *
 *   GET /dashboard — policy-scoped rollup: people, attention, canvases.
 *
 * Bearer-only and thin — every access decision lives in the service
 * behind the shared subject policy. The DTO carries only what the actor
 * may already read elsewhere: unpublished canvases appear as
 * "unpublished" but leak no content.
 */
export function dashboardRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { db, clock, config } = deps;
  const router = Router();
  const auth = createAuthService({ db, clock, config });
  const dashboard = createDashboardService({
    db,
    policy: createPolicy(db),
    clock,
  });

  router.get("/dashboard", requireAuth(auth), async (_req, res: Response) => {
    res.json(await dashboard.getDashboard(res.locals.actor as ActorContext));
  });

  return router;
}
