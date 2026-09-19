import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { AppError } from "./errors.js";

export interface RateLimitOptions {
  /** Window length in milliseconds (fixed window). */
  windowMs: number;
  /** Max requests per key per window. */
  max: number;
  /** Bucket key; defaults to client IP. */
  key?: (req: Request) => string;
}

/**
 * In-memory fixed-window rate limiter. Spec §8 requires rate limiting on
 * setup/login/refresh; this middleware is shared by all of them — each router
 * creates its own instance so buckets never leak between endpoints or app
 * instances (tests included).
 *
 * Process-local by design: correct for the single-process pilot. If the app
 * ever runs multi-process, swap the Map for a shared store — the middleware
 * contract stays the same.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, { windowStart: number; count: number }>();
  const keyOf = options.key ?? ((req: Request) => req.ip ?? "unknown");

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = keyOf(req);
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= options.windowMs) {
      bucket = { windowStart: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > options.max) {
      const retryAfter = Math.max(
        1,
        Math.ceil((bucket.windowStart + options.windowMs - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfter));
      next(
        new AppError(429, "RATE_LIMITED", "Quá nhiều yêu cầu — thử lại sau"),
      );
      return;
    }

    // Bound memory: sweep expired windows once the map grows large.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        if (now - b.windowStart >= options.windowMs) buckets.delete(k);
      }
    }
    next();
  };
}
