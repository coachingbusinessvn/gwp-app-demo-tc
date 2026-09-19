import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { pageLimit } from "../../shared/pagination.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import {
  createUserBodySchema,
  deactivateUserBodySchema,
  setRolesBodySchema,
  updateUserBodySchema,
} from "./schema.js";
import { createUsersService } from "./service.js";

/**
 * /api/v1 user surface (task 1.3, spec §3/§4/§8):
 *
 *   GET  /users?limit&cursor       — directory list, any active member
 *   POST /users                    — create a PENDING member, owner/admin
 *   GET  /users/:id                — directory read, any active member
 *   PATCH /users/:id               — name/title for self; org placement is
 *                                    owner/admin only, admin never on
 *                                    privileged profiles
 *   PUT  /users/:id/roles          — role set replace, OWNER only
 *   POST /users/:id/deactivate     — owner/admin; session kill after commit
 *
 * The reporting line lives on org routes (PUT /users/:id/manager — task
 * 1.2); credential tokens land in task 1.4 — neither is here. Bearer-token
 * mutations need requireAuth only — Origin/CSRF gates protect the
 * cookie-bearing session endpoints, not Bearer calls (spec §8).
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

/** Keyset cursor: the last item id of the previous page; must be a uuid. */
function cursorParam(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new AppError(400, "INVALID_CURSOR", "Con trỏ trang không hợp lệ");
  }
  return raw;
}

export function userRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { db, clock, config } = deps;
  const auth = createAuthService({ db, clock, config });
  const users = createUsersService({
    db,
    clock,
    revokeAllUserSessions: (userId, requestId, reason) =>
      auth.revokeAllUserSessions(userId, requestId, reason),
  });
  const router = Router();

  router.get(
    "/users",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await users.listUsers(actorOf(res), {
          limit: pageLimit(req.query.limit),
          cursor: cursorParam(req.query.cursor),
        }),
      );
    },
  );

  router.post(
    "/users",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(createUserBodySchema, req.body);
      const created = await users.createPendingUser(actorOf(res), body);
      res.status(201).json(created);
    },
  );

  router.get(
    "/users/:id",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      res.json(await users.getUser(actorOf(res), id));
    },
  );

  router.patch(
    "/users/:id",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      const body = parseBody(updateUserBodySchema, req.body);
      if (
        body.name === undefined &&
        body.title === undefined &&
        body.departmentId === undefined &&
        body.teamId === undefined
      ) {
        throw new AppError(400, "INVALID_INPUT", "Không có trường nào để cập nhật", {
          fields: [],
        });
      }
      res.json(await users.updateProfile(actorOf(res), id, body));
    },
  );

  router.put(
    "/users/:id/roles",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      const body = parseBody(setRolesBodySchema, req.body);
      res.json(await users.setRoles(actorOf(res), id, body.roles));
    },
  );

  router.post(
    "/users/:id/deactivate",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      // An absent body is the same as {} — no reports decision supplied.
      const body = parseBody(deactivateUserBodySchema, req.body ?? {});
      res.json(await users.deactivateUser(actorOf(res), id, body));
    },
  );

  return router;
}
