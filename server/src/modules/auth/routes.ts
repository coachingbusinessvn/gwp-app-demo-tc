import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { rateLimit } from "../../shared/rate-limit.js";
import { createCredentialsService } from "../users/credentials.service.js";
import { requireAuth, requireCsrf, requireOrigin } from "./middleware.js";
import {
  changePasswordBodySchema,
  consumeCredentialBodySchema,
  loginBodySchema,
} from "./schema.js";
import { createAuthService } from "./service.js";

/**
 * /api/v1/auth — login, rotating refresh, logout, /me (spec §8).
 *
 * - The refresh token only ever travels in the HttpOnly gwp_refresh cookie
 *   (Secure, SameSite=Strict, Path=/api/v1/auth) — never in a JSON body.
 *   The gwp_csrf double-submit cookie uses Path=/ so app pages can read it
 *   via document.cookie and mirror it into X-CSRF-Token.
 * - login is rate-limited per account+IP AND per IP; refresh/logout per IP.
 * - refresh/logout require the matching Origin header and the double-submit
 *   X-CSRF-Token ↔ gwp_csrf cookie pair.
 * - The CSRF cookie rotates on login and on every refresh.
 */
function parseCredentialBody<T>(
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

export function authRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { config } = deps;
  const auth = createAuthService(deps);
  const credentials = createCredentialsService({
    db: deps.db,
    clock: deps.clock,
  });
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
    // Path=/ — the double-submit cookie must be readable via document.cookie
    // on app pages so JS can mirror it into X-CSRF-Token. It is not a secret
    // (that is the point of double-submit); the refresh token cookie stays
    // scoped to COOKIE_PATH. Changed from COOKIE_PATH in task 0.5 once the
    // real web client existed.
    path: "/",
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
      path: "/", // must match csrfCookie.path or the clear is a no-op
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
  // Token consume + password change: per-IP fixed window like refresh,
  // one bucket per endpoint so flows can't starve each other — the
  // 256-bit token space makes online guessing futile anyway, and the
  // ~250 ms Argon2id verify/hash self-throttles password attempts.
  const activateLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const resetLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const passwordLimiter = rateLimit({ windowMs: 60_000, max: 10 });

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
      // Token-bearing responses are never cacheable (deferred-minor
      // carry-forward: Cache-Control on credential responses).
      res.setHeader("Cache-Control", "no-store");
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
      res.setHeader("Cache-Control", "no-store");
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

  // Public one-time-token consume endpoints (task 1.4): unauthenticated
  // like /login — no session exists yet to protect — and the token itself
  // is the credential. Constant INVALID_TOKEN 400 covers every failure.
  // Consume never issues a session (no cookies are set).
  for (const [path, purpose, limiter] of [
    ["/activate", "activate", activateLimiter],
    ["/reset", "reset", resetLimiter],
  ] as const) {
    router.post(
      path,
      limiter,
      async (req: Request, res: Response) => {
        const body = parseCredentialBody(consumeCredentialBodySchema, req.body);
        await credentials.consumeCredentialToken(
          body.token,
          body.password,
          purpose,
          res.locals.requestId as string,
        );
        res.setHeader("Cache-Control", "no-store");
        res.status(204).end();
      },
    );
  }

  // Self-service password change (task 1.4): Bearer-auth like the user
  // routes — no Origin/CSRF gate (no cookie is presented). Success revokes
  // EVERY session of the caller, including this one (spec §8).
  router.post(
    "/password",
    passwordLimiter,
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseCredentialBody(changePasswordBodySchema, req.body);
      const actor = res.locals.actor as ActorContext;
      await credentials.changeOwnPassword(
        actor,
        body.currentPassword,
        body.newPassword,
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(204).end();
    },
  );

  return router;
}
