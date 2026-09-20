import { randomUUID } from "node:crypto";
import path from "node:path";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import type { Knex } from "knex";
import type { Config } from "./config.js";
import { migrationStatus } from "./db/migrate.js";
import { loadOpenApiSpec } from "./openapi.js";
import { authRoutes } from "./modules/auth/routes.js";
import { setupRoutes } from "./modules/auth/setup.routes.js";
import { auditRoutes } from "./modules/audit/routes.js";
import { canvasRoutes } from "./modules/canvas/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { orgRoutes } from "./modules/org/routes.js";
import { settingsRoutes } from "./modules/settings/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { AppError } from "./shared/errors.js";
import type { AppErrorBody, Clock } from "./shared/contracts.js";

export interface AppDeps {
  db: Knex;
  clock: Clock;
  config: Config;
}

const JSON_LIMIT = 2 * 1024 * 1024; // 2 MiB — global constraint.

/**
 * Route conventions for all modules (tasks 0.3+):
 * - ActorContext is built by server-side auth middleware only; routes must
 *   never accept companyId/role/userId from the client to construct it.
 *   Expected failures are thrown as AppError(status, code, message, details?).
 * - The final error handler is registered last, after the JSON parser and
 *   every router — anything thrown/notFound flows through it.
 */
export function createApp({ db, clock, config }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  // Request id: generated server-side, echoed as X-Request-Id header and as
  // request_id inside the error envelope.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  });

  app.use(helmet());
  app.use(cookieParser());
  app.use(express.json({ limit: JSON_LIMIT }));

  // Liveness never touches the database.
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", now: clock().toISOString() });
  });

  // Readiness: DB connectivity + migration status. OK while zero migration
  // files exist (task 0.2 ships the first real ones via MIGRATIONS). Any
  // failure of either check — connectivity or the migration probe itself —
  // surfaces as a 503, never a 500.
  app.get("/health/ready", async (_req, res, next) => {
    let status;
    try {
      await db.raw("select 1");
      status = await migrationStatus(db);
    } catch {
      return next(
        new AppError(503, "DB_UNAVAILABLE", "Cơ sở dữ liệu không sẵn sàng"),
      );
    }
    if (status.pending.length > 0) {
      return next(
        new AppError(503, "MIGRATIONS_PENDING", "Chưa chạy đủ migrations", {
          pending: status.pending,
        }),
      );
    }
    res.json({ status: "ok" });
  });

  // OpenAPI contract (task 0.6, spec §2): parsed once at startup from
  // <repo>/server/openapi.yaml — a missing/invalid document fails the boot.
  // Public surface only; the deployment test asserts it carries no secrets.
  const openApiSpec = loadOpenApiSpec();
  app.get("/api/v1/openapi.json", (_req, res) => {
    res.json(openApiSpec);
  });

  // Module routers mount here, BEFORE the catch-all:
  app.use("/api/v1", setupRoutes({ db, config })); // task 0.3
  app.use("/api/v1/auth", authRoutes({ db, clock, config })); // task 0.4
  app.use("/api/v1", orgRoutes({ db, clock, config })); // task 1.1
  app.use("/api/v1", userRoutes({ db, clock, config })); // task 1.3
  app.use("/api/v1", settingsRoutes({ db, clock, config })); // task 1.5
  app.use("/api/v1", auditRoutes({ db, clock, config })); // task 1.5
  app.use("/api/v1", canvasRoutes({ db, clock, config })); // task 2.3
  app.use("/api/v1", dashboardRoutes({ db, clock, config })); // task 2.6

  // Canvas editor (task 2.5): the pinned URL /canvas-online/?canvas=<id>
  // serves the built editor page. It is a static artifact, but directory
  // index serving is disabled boundary-wide, so the directory URL gets an
  // explicit route instead of weakening the static boundary.
  app.get(["/canvas-online", "/canvas-online/"], (_req, res) => {
    res.sendFile(path.join(config.publicDir, "canvas-online", "index.html"));
  });

  // Public asset boundary (task 0.5, spec §2): serve ONLY the allowlisted
  // build output at config.publicDir (<repo>/public-build) — never the
  // repository root, never dotfiles, no implicit index.html on directories.
  // Anything unresolved falls through to the JSON 404 below.
  app.use(
    express.static(config.publicDir, { dotfiles: "deny", index: false }),
  );

  // Unknown /api/v1/* and any other unmatched path → JSON 404 NOT_FOUND.
  app.use((_req, _res, next) => {
    next(new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên"));
  });

  // Final error handler — produces the shared AppErrorBody envelope.
  // Responses never contain stack traces, secrets or internal detail.
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const requestId =
        (res.locals.requestId as string | undefined) ?? randomUUID();
      const send = (
        status: number,
        code: string,
        message: string,
        details?: unknown,
      ) => {
        const body: AppErrorBody = { code, message, request_id: requestId };
        if (details !== undefined) body.details = details;
        res.status(status).json(body);
      };

      if (err instanceof AppError) {
        send(err.status, err.code, err.message, err.details);
        return;
      }

      const e = err as { status?: unknown; type?: unknown } | null;
      const status =
        typeof e?.status === "number" && e.status >= 400 && e.status < 600
          ? e.status
          : 500;

      if (status >= 500) {
        console.error(`[request ${requestId}] unhandled error:`, err);
        send(500, "INTERNAL", "Lỗi hệ thống");
        return;
      }

      const code =
        e?.type === "entity.too.large"
          ? "PAYLOAD_TOO_LARGE"
          : e?.type === "entity.parse.failed"
            ? "INVALID_JSON"
            : "BAD_REQUEST";
      send(status, code, "Yêu cầu không hợp lệ");
    },
  );

  return app;
}
