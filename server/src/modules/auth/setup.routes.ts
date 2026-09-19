import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import { rateLimit } from "../../shared/rate-limit.js";
import { setup } from "./setup.service.js";

/**
 * POST /setup — guarded first-run bootstrap (spec §8). Rate-limited by IP;
 * the shared limiter factory is reused by login/refresh in task 0.4.
 * Express 5 forwards thrown AppError to the envelope handler.
 */
export function setupRoutes(deps: { db: Knex; config: Config }): Router {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, max: 10 });

  router.post("/setup", limiter, async (req: Request, res: Response) => {
    const requestId = res.locals.requestId as string;
    const result = await setup(deps.db, deps.config, req.body, requestId);
    // {userId, companyId} only — setup never issues tokens.
    res.status(201).json(result);
  });

  return router;
}
