import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { pageLimit } from "../../shared/pagination.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import { listAuditEvents, type AuditCursor } from "./service.js";

/**
 * /api/v1 audit surface (task 1.5, spec §4/§9):
 *
 *   GET /audit?limit&cursor — owner/admin only; metadata-only rows
 *   (id, at, actorId, action, outcome, requestId, targetType/targetId and
 *   allowlisted safe_metadata), newest-first keyset pagination. There is
 *   deliberately no way to read a raw audit row or any content payload.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function actorOf(res: Response): ActorContext {
  return res.locals.actor as ActorContext;
}

/**
 * Composite keyset cursor `<iso>|<uuid>` — the (created_at, id) position
 * of the previous page's last row. Anything malformed is INVALID_CURSOR,
 * same convention as the uuid cursors on the other list routes.
 */
function cursorParam(raw: unknown): AuditCursor | undefined {
  if (raw === undefined) return undefined;
  const s = typeof raw === "string" ? raw : "";
  const sep = s.lastIndexOf("|");
  const at = sep > 0 ? s.slice(0, sep) : "";
  const id = sep > 0 ? s.slice(sep + 1) : "";
  // The timestamp half is Postgres-rendered µs ISO (e.g.
  // 2026-09-20T00:26:34.123456Z) — the regex allows any µs width and the
  // string is passed back to ::timestamptz verbatim, so no precision is
  // lost between pages.
  if (!ISO_INSTANT_RE.test(at) || !UUID_RE.test(id)) {
    throw new AppError(400, "INVALID_CURSOR", "Con trỏ trang không hợp lệ");
  }
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(400, "INVALID_CURSOR", "Con trỏ trang không hợp lệ");
  }
  return { at, id };
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
          cursor: cursorParam(req.query.cursor),
        }),
      );
    },
  );

  return router;
}
