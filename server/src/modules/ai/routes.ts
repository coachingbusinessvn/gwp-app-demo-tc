import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { rateLimit } from "../../shared/rate-limit.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import { aiSettingsPutSchema } from "./schema.js";
import { createAiSettingsService } from "./settings.js";

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

export function aiRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { db, clock, config } = deps;
  const auth = createAuthService({ db, clock, config });
  const ai = createAiSettingsService({ db, clock, config });
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

  return router;
}
