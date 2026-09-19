import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Id } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { appendAudit } from "../audit/service.js";
import { hashPassword } from "./password.js";

/**
 * First-run owner bootstrap (spec §8). One-shot: requires the operator's
 * bootstrap token, runs only while deployment_state.setup_completed_at is
 * NULL, and permanently locks setup inside the same transaction that creates
 * the company+owner — a raced request or a restart can never reopen it.
 */
export interface SetupResult {
  userId: Id;
  companyId: Id;
}

const SETUP_ACTION = "setup.bootstrap";

// bootstrapToken is deliberately absent here — it is compared constant-time
// BEFORE validation so a wrong/missing token always yields the same generic
// 401 regardless of what else is wrong with the body.
const setupBodySchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  password: z.string().min(12).max(256),
});

function bootstrapTokenMatches(provided: string, expected: string): boolean {
  // timingSafeEqual needs equal-length buffers; comparing SHA-256 digests
  // keeps the comparison constant-time without leaking the token's length.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Best-effort failure audit. audit_event.company_id is NOT NULL, so a
 * failure before any company exists has nothing to attach to and is skipped;
 * once a company exists (e.g. hammering setup after it closed) the failure
 * is recorded against it. Never throws — auditing must not mask the real
 * error.
 */
async function auditSetupFailure(
  db: Knex,
  requestId: string,
  errorCode: string,
): Promise<void> {
  try {
    const company = await db("company").select("id").first();
    if (!company) return;
    await db.transaction(async (tx) => {
      await appendAudit(tx, {
        companyId: company.id as string,
        action: SETUP_ACTION,
        outcome: "failure",
        requestId,
        metadata: { error_code: errorCode },
      });
    });
  } catch (err) {
    console.error("setup failure audit failed:", err);
  }
}

export async function setup(
  db: Knex,
  config: Config,
  rawInput: unknown,
  requestId: string,
): Promise<SetupResult> {
  const raw: Record<string, unknown> =
    typeof rawInput === "object" && rawInput !== null
      ? (rawInput as Record<string, unknown>)
      : {};
  const providedToken =
    typeof raw.bootstrapToken === "string" ? raw.bootstrapToken : "";

  // Generic 401 — the response must never reveal which part failed.
  if (!bootstrapTokenMatches(providedToken, config.bootstrapToken)) {
    await auditSetupFailure(db, requestId, "unauthorized");
    throw new AppError(
      401,
      "SETUP_UNAUTHORIZED",
      "Yêu cầu thiết lập không hợp lệ",
    );
  }

  const parsed = setupBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "INVALID_INPUT", "Dữ liệu thiết lập không hợp lệ", {
      fields: parsed.error.issues.map((i) => i.path.join(".")),
    });
  }
  const input = parsed.data;

  // Hash BEFORE the transaction — ~240 ms of CPU must not hold the
  // deployment_state row lock.
  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();
  const companyId = randomUUID();

  try {
    await db.transaction(async (tx) => {
      // Lock the singleton first: a racing setup serializes on this row lock
      // and, once the winner commits, sees setup_completed_at → 409. Exactly
      // one 201, no retries.
      const state = await tx("deployment_state")
        .where({ singleton_id: 1 })
        .forUpdate()
        .first();
      if (!state) {
        throw new AppError(
          500,
          "DEPLOYMENT_STATE_MISSING",
          "Thiếu trạng thái triển khai — chạy db:migrate",
        );
      }
      if (state.setup_completed_at) {
        throw new AppError(409, "SETUP_CLOSED", "Đã thiết lập");
      }
      if (state.mode !== config.mode) {
        throw new AppError(409, "MODE_MISMATCH", "Sai chế độ triển khai");
      }

      // IDs are generated app-side; role is always the seeded owner role —
      // never taken from the request.
      await tx("company").insert({ id: companyId, name: input.companyName });
      await tx("app_user").insert({
        id: userId,
        company_id: companyId,
        email: input.email,
        name: input.email, // setup collects no display name yet (Phase 1 org)
        status: "active",
        password_hash: passwordHash,
      });
      const ownerRole = await tx("role")
        .select("id")
        .where({ key: "owner" })
        .first();
      if (!ownerRole) {
        throw new AppError(500, "ROLE_MISSING", "Thiếu role owner");
      }
      await tx("user_role").insert({
        company_id: companyId,
        user_id: userId,
        role_id: ownerRole.id,
      });

      await appendAudit(tx, {
        companyId,
        actorId: userId,
        action: SETUP_ACTION,
        targetType: "company",
        targetId: companyId,
        outcome: "success",
        requestId,
        metadata: { mode: state.mode },
      });

      // Lock setup permanently in the SAME transaction.
      await tx("deployment_state")
        .where({ singleton_id: 1 })
        .update({ setup_completed_at: tx.fn.now() });
    });
  } catch (err) {
    if (
      err instanceof AppError &&
      (err.code === "SETUP_CLOSED" || err.code === "MODE_MISMATCH")
    ) {
      await auditSetupFailure(db, requestId, err.code.toLowerCase());
    }
    throw err;
  }

  return { userId, companyId };
}
