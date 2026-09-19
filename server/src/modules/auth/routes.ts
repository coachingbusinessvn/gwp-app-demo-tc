import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { rateLimit } from "../../shared/rate-limit.js";
import { requireAuth, requireCsrf, requireOrigin } from "./middleware.js";
import { loginBodySchema } from "./schema.js";
import { createAuthService } from "./service.js";

/**
 * /api/v1/auth — login, rotating refresh, logout, /me (spec §8).
 *
 * - The refresh token only ever travels in the HttpOnly gwp_refresh cookie
 *   (Secure, SameSite=Strict, Path=/api/v1/auth) — never in a JSON body.
 * - login is rate-limited per account+IP AND per IP; refresh/logout per IP.
 * - refresh/logout require the matching Origin header and the double-submit
 *   X-CSRF-Token ↔ gwp_csrf cookie pair.
 * - The CSRF cookie rotates on login and on every refresh.
 */
export function authRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { config } = deps;
  const auth = createAuthService(deps);
  const router = Router();

  const COOKIE_PATH = "/api/v1/auth";
  const refreshCookie = {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: config.refreshTokenTtlSeconds * 1000,
  } as const;
  const csrfCookie = {
    httpOnly: false,
    secure: true,
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: config.refreshTokenTtlSeconds * 1000,
  } as const;

  const setSessionCookies = (
    res: Response,
    tokens: { refreshToken: string; csrfToken: string },
  ): void => {
    res.cookie(config.refreshCookieName, tokens.refreshToken, refreshCookie);
    res.cookie(config.csrfCookieName, tokens.csrfToken, csrfCookie);
  };

  const clearSessionCookies = (res: Response): void => {
    res.clearCookie(config.refreshCookieName, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: COOKIE_PATH,
    });
    res.clearCookie(config.csrfCookieName, {
      secure: true,
      sameSite: "strict",
      path: COOKIE_PATH,
    });
  };

  // Spec §8: login limited by account AND by IP. req.ip already honours the
  // configured trust-proxy setting (app.set("trust proxy", config.trustProxy)).
  const loginIpLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const loginAccountLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    key: (req: Request) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return `${req.ip}|${
        typeof email === "string" ? email.trim().toLowerCase() : "?"
      }`;
    },
  });
  const sessionLimiter = rateLimit({ windowMs: 60_000, max: 30 });

  router.post(
    "/login",
    loginIpLimiter,
    loginAccountLimiter,
    async (req: Request, res: Response) => {
      const parsed = loginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "INVALID_INPUT", "Dữ liệu đăng nhập không hợp lệ", {
          fields: parsed.error.issues.map((i) => i.path.join(".")),
        });
      }
      const result = await auth.login(
        parsed.data.email,
        parsed.data.password,
        res.locals.requestId as string,
      );
      setSessionCookies(res, result);
      res.json({ accessToken: result.accessToken, user: result.user });
    },
  );

  router.post(
    "/refresh",
    sessionLimiter,
    requireOrigin(config),
    requireCsrf(config),
    async (req: Request, res: Response) => {
      const raw: unknown = req.cookies?.[config.refreshCookieName];
      if (typeof raw !== "string" || raw === "") {
        throw new AppError(401, "INVALID_SESSION", "Phiên không hợp lệ");
      }
      const result = await auth.rotate(raw, res.locals.requestId as string);
      setSessionCookies(res, result);
      res.json({ accessToken: result.accessToken });
    },
  );

  router.post(
    "/logout",
    sessionLimiter,
    requireOrigin(config),
    requireCsrf(config),
    async (req: Request, res: Response) => {
      const raw: unknown = req.cookies?.[config.refreshCookieName];
      if (typeof raw === "string" && raw !== "") {
        await auth.revokeByRefreshToken(raw, res.locals.requestId as string);
      }
      clearSessionCookies(res);
      res.status(204).end();
    },
  );

  router.get(
    "/me",
    requireAuth(auth),
    async (_req: Request, res: Response) => {
      const actor = res.locals.actor as ActorContext;
      res.json(await auth.loadProfile(actor));
    },
  );

  return router;
}
