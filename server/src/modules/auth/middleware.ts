import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Config } from "../../config.js";
import type { ActorContext } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import type { AuthService } from "./service.js";

/**
 * Bearer-auth middleware: builds the ActorContext server-side via
 * AuthService.authenticate (which hits the DB on every request) and stashes
 * it on res.locals.actor. Routes never trust client-supplied identity.
 */
export function requireAuth(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    try {
      const header = req.get("authorization") ?? "";
      const match = /^Bearer (\S+)\s*$/i.exec(header.trim());
      if (!match) {
        throw new AppError(401, "INVALID_SESSION", "Phiên không hợp lệ");
      }
      const actor = await auth.authenticate(
        match[1],
        res.locals.requestId as string,
      );
      res.locals.actor = actor satisfies ActorContext;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Origin gate for cookie-bearing mutations (spec §8): the Origin header must
 * equal the configured app origin exactly — missing or mismatched → 403.
 */
export function requireOrigin(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (req.get("origin") !== config.appOrigin) {
      next(new AppError(403, "ORIGIN_MISMATCH", "Origin không hợp lệ"));
      return;
    }
    next();
  };
}

/** Constant-time compare without leaking token length. */
function tokenEquals(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * Double-submit CSRF check: the non-HttpOnly gwp_csrf cookie must match the
 * X-CSRF-Token header. SameSite=Strict already blocks cross-site sends; this
 * covers the cases where the cookie does get through (spec §8).
 */
export function requireCsrf(config: Config): RequestHandler {
  return (req, _res, next) => {
    const cookie: unknown = req.cookies?.[config.csrfCookieName];
    const header = req.get("x-csrf-token");
    const ok =
      typeof cookie === "string" &&
      cookie.length > 0 &&
      typeof header === "string" &&
      header.length > 0 &&
      tokenEquals(cookie, header);
    if (!ok) {
      next(new AppError(403, "CSRF_MISMATCH", "CSRF token không hợp lệ"));
      return;
    }
    next();
  };
}
