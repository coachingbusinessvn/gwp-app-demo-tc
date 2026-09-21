import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import {
  brandingSchema,
  createSettingsService,
  retentionSchema,
} from "./service.js";

/**
 * /api/v1 settings surface (task 1.5, spec §4/§9):
 *
 *   GET   /settings/branding — any authenticated member (it personalizes
 *                             the shell for everyone)
 *   PATCH /settings/branding — owner/admin only; strict
 *                             {displayName, accentColor:#hex} body, full
 *                             replace — there is no field that can carry
 *                             HTML, a URL or CSS text.
 *   GET   /settings/retention — owner/admin; the retention floors in
 *                             force (defaults when unconfigured).
 *   PATCH /settings/retention — owner only; full replace of the floors,
 *                             each bounded below by the spec minimums —
 *                             retention can only ever be increased.
 *
 * Bearer-token mutations need requireAuth only — Origin/CSRF gates protect
 * the cookie-bearing session endpoints, not Bearer calls (spec §8).
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

export function settingsRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { db, clock, config } = deps;
  const auth = createAuthService({ db, clock, config });
  const settings = createSettingsService({ db, clock });
  const router = Router();

  router.get(
    "/settings/branding",
    requireAuth(auth),
    async (_req: Request, res: Response) => {
      res.json(await settings.getBranding(actorOf(res)));
    },
  );

  router.patch(
    "/settings/branding",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(brandingSchema, req.body);
      res.json(await settings.updateBranding(actorOf(res), body));
    },
  );

  // Retention floors (task 4.5, spec §9): owner/admin read; the write is
  // owner-only and the schema min() bounds make a decrease impossible.
  router.get(
    "/settings/retention",
    requireAuth(auth),
    async (_req: Request, res: Response) => {
      res.json(await settings.getRetention(actorOf(res)));
    },
  );

  router.patch(
    "/settings/retention",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(retentionSchema, req.body);
      res.json(await settings.updateRetention(actorOf(res), body));
    },
  );

  return router;
}
