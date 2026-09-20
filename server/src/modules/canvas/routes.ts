import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { keysetCursorParam, pageLimit } from "../../shared/pagination.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import { createPolicy } from "../authorization/policy.js";
import { createCanvasService } from "./service.js";
import {
  createCanvasBodySchema,
  publishBodySchema,
  restoreBodySchema,
  saveDraftBodySchema,
  transferBodySchema,
} from "./schema.js";

/**
 * /api/v1 canvas surface (tasks 2.3/2.4, spec §4/§5):
 *
 *   POST /canvases                                — create canvas + first draft
 *   GET  /canvases?limit&cursor                   — subject-scoped keyset page
 *   GET  /canvases/:id                            — canvas detail
 *   POST /canvases/:id/draft                      — open the shared draft
 *   PUT  /canvases/:id/draft                      — CAS save (expectedRevision)
 *   POST /canvases/:id/publish                    — idempotent publish
 *   GET  /canvases/:id/versions                   — published history list
 *   GET  /canvases/:id/versions/:versionId        — one published snapshot
 *   POST /canvases/:id/versions/:versionId/restore — restore into the draft
 *   POST /canvases/:id/archive                    — archive (write-off flag)
 *   POST /canvases/:id/transfer                   — owner-only transfer
 *
 * Every handler is Bearer-only (requireAuth) and thin: parseBody + actorOf
 * + path-id → 404. All access decisions live in the service behind the
 * shared subject policy; there is deliberately no version mutation route —
 * published snapshots are immutable (spec §5.2).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
          // Shared keyset parser — rejects impossible dates (JS normalizes
          // them, Postgres then throws 22008) as 400, never a 500.
          cursor: keysetCursorParam(req.query.cursor),
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

  router.put(
    "/canvases/:id/draft",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(saveDraftBodySchema, req.body);
      res.json(
        await canvas.saveDraft(actorOf(res), pathId(req.params.id), body),
      );
    },
  );

  router.post(
    "/canvases/:id/publish",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(publishBodySchema, req.body);
      res.json(
        await canvas.publish(actorOf(res), pathId(req.params.id), body),
      );
    },
  );

  // Bounded ordered list — versions are few per canvas, so no cursor.
  router.get(
    "/canvases/:id/versions",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await canvas.listVersions(actorOf(res), pathId(req.params.id)),
      );
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

  router.post(
    "/canvases/:id/versions/:versionId/restore",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      // The body is optional — restoring onto an empty canvas needs none.
      const body = parseBody(restoreBodySchema, req.body ?? {});
      res.json(
        await canvas.restore(
          actorOf(res),
          pathId(req.params.id),
          pathId(req.params.versionId),
          body,
        ),
      );
    },
  );

  router.post(
    "/canvases/:id/archive",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(await canvas.archive(actorOf(res), pathId(req.params.id)));
    },
  );

  router.post(
    "/canvases/:id/transfer",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(transferBodySchema, req.body);
      res.json(
        await canvas.transferOwner(
          actorOf(res),
          pathId(req.params.id),
          body.newOwnerId,
        ),
      );
    },
  );

  return router;
}
