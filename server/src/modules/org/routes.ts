import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { pageLimit } from "../../shared/pagination.js";
import { createAuthService } from "../auth/service.js";
import { requireAuth } from "../auth/middleware.js";
import {
  createDepartmentBodySchema,
  createTeamBodySchema,
  updateCompanyBodySchema,
  updateDepartmentBodySchema,
  updateTeamBodySchema,
} from "./schema.js";
import { createOrgService } from "./service.js";

/**
 * /api/v1 org surface (task 1.1, spec §3/§4):
 *
 *   GET   /company                  — singleton profile, any company member
 *   PATCH /company                  — profile update, owner/admin
 *   GET   /departments?limit&cursor — company-scoped keyset page
 *   POST  /departments              — create, owner/admin
 *   PATCH /departments/:id          — rename, owner/admin
 *   POST  /departments/:id/archive  — archive, owner/admin (409 in use)
 *   GET   /teams?limit&cursor&departmentId
 *   POST  /teams                    — create, owner/admin
 *   PATCH /teams/:id                — rename/move, owner/admin
 *   POST  /teams/:id/archive        — archive, owner/admin (409 in use)
 *
 * There is deliberately NO /api/v1/companies route: one deployment = one
 * company, so company create/list is an unknown route → 404 (spec §3).
 * Bearer-token mutations need requireAuth only — Origin/CSRF gates protect
 * the cookie-bearing session endpoints, not Bearer calls (spec §8).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(res: Response): ActorContext {
  return res.locals.actor as ActorContext;
}

function parseBody<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: { path: PropertyKey[] }[] } } },
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

export function orgRoutes(deps: {
  db: Knex;
  clock: Clock;
  config: Config;
}): Router {
  const { db, clock, config } = deps;
  const auth = createAuthService({ db, clock, config });
  const org = createOrgService({ db, clock });
  const router = Router();

  router.get(
    "/company",
    requireAuth(auth),
    async (_req: Request, res: Response) => {
      res.json(await org.getCompany(actorOf(res)));
    },
  );

  router.patch(
    "/company",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(updateCompanyBodySchema, req.body);
      if (body.name === undefined && body.timezone === undefined) {
        throw new AppError(400, "INVALID_INPUT", "Không có trường nào để cập nhật", {
          fields: [],
        });
      }
      res.json(await org.updateCompany(actorOf(res), body));
    },
  );

  router.get(
    "/departments",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      res.json(
        await org.listDepartments(actorOf(res), {
          limit: pageLimit(req.query.limit),
          cursor: cursorParam(req.query.cursor),
        }),
      );
    },
  );

  router.post(
    "/departments",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(createDepartmentBodySchema, req.body);
      const created = await org.createDepartment(actorOf(res), body);
      res.status(201).json(created);
    },
  );

  router.patch(
    "/departments/:id",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      const body = parseBody(updateDepartmentBodySchema, req.body);
      res.json(await org.updateDepartment(actorOf(res), id, body));
    },
  );

  router.post(
    "/departments/:id/archive",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      res.json(await org.archiveOrgUnit(actorOf(res), "department", id));
    },
  );

  router.get(
    "/teams",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const departmentId = req.query.departmentId;
      if (departmentId !== undefined && !UUID_RE.test(String(departmentId))) {
        throw new AppError(400, "INVALID_INPUT", "Dữ liệu không hợp lệ", {
          fields: ["departmentId"],
        });
      }
      res.json(
        await org.listTeams(actorOf(res), {
          limit: pageLimit(req.query.limit),
          cursor: cursorParam(req.query.cursor),
          departmentId:
            departmentId === undefined ? undefined : String(departmentId),
        }),
      );
    },
  );

  router.post(
    "/teams",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const body = parseBody(createTeamBodySchema, req.body);
      const created = await org.createTeam(actorOf(res), body);
      res.status(201).json(created);
    },
  );

  router.patch(
    "/teams/:id",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      const body = parseBody(updateTeamBodySchema, req.body);
      if (body.name === undefined && body.departmentId === undefined) {
        throw new AppError(400, "INVALID_INPUT", "Không có trường nào để cập nhật", {
          fields: [],
        });
      }
      res.json(await org.updateTeam(actorOf(res), id, body));
    },
  );

  router.post(
    "/teams/:id/archive",
    requireAuth(auth),
    async (req: Request, res: Response) => {
      const id = pathId(req.params.id);
      res.json(await org.archiveOrgUnit(actorOf(res), "team", id));
    },
  );

  return router;
}
