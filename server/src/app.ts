import { randomUUID } from "node:crypto";
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

  // Module routers mount here, BEFORE the catch-all:
  //   app.use("/api/v1/auth", authRoutes)            // task 0.4
  //   app.use(express.static(config.publicDir, ...)) // task 0.5

  // Unknown /api/v1/* → JSON 404 with NOT_FOUND code; any other unknown path
  // also gets the JSON envelope until static serving lands in task 0.5.
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
