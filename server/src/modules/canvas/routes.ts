import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { pageLimit } from "../../shared/pagination.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import { createPolicy } from "../authorization/policy.js";
import { createCanvasService } from "./service.js";
import { createCanvasBodySchema } from "./schema.js";
import type { CanvasCursor } from "./queries.js";

/**
 * /api/v1 canvas surface (task 2.3, spec §4/§5):
 *
 *   POST /canvases                          — create canvas + first draft
 *   GET  /canvases?limit&cursor             — subject-scoped keyset page
 *   GET  /canvases/:id                      — canvas detail
 *   POST /canvases/:id/draft                — open the shared draft
 *   GET  /canvases/:id/versions/:versionId  — one published snapshot
 *
 * Every handler is Bearer-only (requireAuth) and thin: parseBody + actorOf
 * + path-id → 404. All access decisions live in the service behind the
 * shared subject policy; there is deliberately no version mutation route —
 * published snapshots are immutable (spec §5.2).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

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

/** A path id that cannot be a uuid is a nonexistent resource → 404. */
function pathId(raw: string | string[]): string {
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
  }
  return id;
}

/**
 * Composite keyset cursor `<iso-µs>|<uuid>` — the (created_at, id) position
 * of the previous page's last row, same convention as GET /audit. Anything
 * malformed is INVALID_CURSOR.
 */
function cursorParam(raw: unknown): CanvasCursor | undefined {
  if (raw === undefined) return undefined;
  const s = typeof raw === "string" ? raw : "";
  const sep = s.lastIndexOf("|");
  const at = sep > 0 ? s.slice(0, sep) : "";
  const id = sep > 0 ? s.slice(sep + 1) : "";
  if (!ISO_INSTANT_RE.test(at) || !UUID_RE.test(id)) {
    throw new AppError(400, "INVALID_CURSOR", "Con trỏ trang không hợp lệ");
  }
  if (!Number.isFinite(new Date(at).getTime())) {
    throw new AppError(400, "INVALID_CURSOR", "Con trỏ trang không hợp lệ");
  }
  return { at, id };
}

export function canvasRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { db, clock, config } = deps;
  const auth = createAuthService({ db, clock, config });
  const canvas = createCanvasService({
    db,
    policy: createPolicy(db),
    clock,
  });
  const router = Router();

  router.post(
    "/canvases",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(createCanvasBodySchema, req.body);
      const created = await canvas.createCanvas(actorOf(res), body);
      res.status(201).json(created);
    },
  );

  router.get(
    "/canvases",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await canvas.listCanvases(actorOf(res), {
          limit: pageLimit(req.query.limit),
          cursor: cursorParam(req.query.cursor),
        }),
      );
    },
  );

  router.get(
    "/canvases/:id",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(await canvas.getCanvas(actorOf(res), pathId(req.params.id)));
    },
  );

  router.post(
    "/canvases/:id/draft",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const draft = await canvas.createDraft(
        actorOf(res),
        pathId(req.params.id),
      );
      res.status(201).json(draft);
    },
  );

  router.get(
    "/canvases/:id/versions/:versionId",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await canvas.getVersion(
          actorOf(res),
          pathId(req.params.id),
          pathId(req.params.versionId),
        ),
      );
    },
  );

  return router;
}
