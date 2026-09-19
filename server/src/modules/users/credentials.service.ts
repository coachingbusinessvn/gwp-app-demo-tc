import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { ActorContext, Clock, Id } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { appendAudit } from "../audit/service.js";
import { loadActorRoles } from "../authorization/repository.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  findUserById as findAuthUserById,
  type UserRow as AuthUserRow,
} from "../auth/repository.js";
import { revokeAllUserSessionsInTx } from "../auth/service.js";
import { findUserById } from "./repository.js";

/**
 * Credential lifecycle (task 1.4, spec §8):
 *
 * - issueCredentialToken — OWNER ONLY (admin → 403 even for a member
 *   target, and owner self-issuance → 403: self-service is
 *   changeOwnPassword). 'activate' is issuable only for pending users,
 *   'reset' only for active ones. The 256-bit token is returned to the
 *   issuer exactly once — the DB row holds only its SHA-256 hex digest,
 *   so a full-table dump never contains a usable token. Issuing again
 *   supersedes the previous unused token of the same user+purpose (its
 *   used_at is stamped — superseded reads exactly like consumed).
 * - consumeCredentialToken — public, bound to the endpoint's purpose. One
 *   constant INVALID_TOKEN 400 covers unknown/expired/used/wrong-purpose/
 *   wrong-status tokens; the Argon2id hash of the new password is computed
 *   BEFORE the transaction so every path pays the same ~250 ms and the
 *   token row lock is never held during hashing. In one tx: lock the token
 *   row FOR UPDATE → validate → stamp used_at → set password_hash,
 *   status='active', auth_version+1 → revoke every live session (in-tx via
 *   revokeAllUserSessionsInTx) → audit. Consume never issues a session.
 * - changeOwnPassword — verifies the current Argon2id hash (same generic
 *   INVALID_CREDENTIALS on any mismatch), then rotates hash + auth_version
 *   and revokes ALL sessions INCLUDING the caller's — re-login is
 *   mandatory (spec §8: password change revokes every session).
 */
export type CredentialPurpose = "activate" | "reset";

export interface IssuedCredentialToken {
  token: string;
  expiresAt: string;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // spec §8: mã kích hoạt hết hạn 24 giờ.

/** Deterministic SHA-256 hex digest; the raw token is never stored/logged. */
function hashCredentialToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function invalidToken(): AppError {
  // One constant error for unknown/expired/used/wrong-purpose — the
  // response must never reveal which check failed.
  return new AppError(400, "INVALID_TOKEN", "Mã không hợp lệ hoặc đã hết hạn");
}

function notFound(): AppError {
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

interface OneTimeTokenRow {
  id: string;
  company_id: string;
  user_id: string;
  token_hash: string;
  purpose: string;
  expires_at: Date;
  used_at: Date | null;
  created_by: string;
}

export interface CredentialsDeps {
  db: Knex;
  clock: Clock;
}

export function createCredentialsService({ db, clock }: CredentialsDeps) {
  /** Defense in depth behind authenticate(): the actor must be active. */
  async function requireActiveActor(
    tx: Knex.Transaction,
    actor: ActorContext,
  ): Promise<void> {
    const me = await findUserById(tx, actor.companyId, actor.userId);
    if (!me || me.status !== "active") {
      throw new AppError(403, "FORBIDDEN", "Tài khoản không hoạt động");
    }
  }

  /**
   * Best-effort failure audit for token consume attempts where a row
   * exists (expired/used/wrong-purpose/wrong-status replay is a security
   * signal). An unknown hash has no company to attach to and is skipped.
   * Never throws — auditing must not mask the real INVALID_TOKEN.
   */
  async function auditConsumeFailure(
    row: OneTimeTokenRow,
    requestId: string,
  ): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await appendAudit(tx, {
          companyId: row.company_id,
          actorId: row.user_id,
          action: "credential.consume",
          targetType: "app_user",
          targetId: row.user_id,
          outcome: "failure",
          requestId,
          metadata: { error_code: "invalid_token" },
        });
      });
    } catch (err) {
      console.error("credential consume failure audit failed:", err);
    }
  }

  async function issueCredentialToken(
    actor: ActorContext,
    userId: Id,
    purpose: CredentialPurpose,
  ): Promise<IssuedCredentialToken> {
    const token = randomBytes(32).toString("base64url"); // 256-bit CSPRNG
    const tokenHash = hashCredentialToken(token);
    const expiresAt = new Date(clock().getTime() + TOKEN_TTL_MS);

    await db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
      if (!roles.includes("owner")) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ owner được phát hành mã xác thực",
        );
      }
      await requireActiveActor(tx, actor);

      const target = await findUserById(tx, actor.companyId, userId);
      if (!target) throw notFound();
      // Self-issuance is refused: an owner resets their own password via
      // changeOwnPassword, never via a bearer-token they could leak to
      // themself — the token channel exists for OTHER people's accounts.
      if (target.id === actor.userId) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Owner không thể tự phát hành mã cho chính mình",
        );
      }
      if (purpose === "activate" && target.status !== "pending") {
        throw new AppError(
          409,
          "USER_NOT_PENDING",
          "Mã kích hoạt chỉ áp dụng cho tài khoản đang chờ",
        );
      }
      if (purpose === "reset" && target.status !== "active") {
        throw new AppError(
          409,
          "USER_NOT_ACTIVE",
          "Mã reset chỉ áp dụng cho tài khoản đang hoạt động",
        );
      }

      // Supersede: mark any previous unused token of this user+purpose
      // consumed — a re-issue leaves exactly one live token.
      await tx("one_time_token")
        .where({
          company_id: actor.companyId,
          user_id: userId,
          purpose,
        })
        .whereNull("used_at")
        .update({ used_at: clock() });

      await tx("one_time_token").insert({
        id: randomUUID(),
        company_id: actor.companyId,
        user_id: userId,
        token_hash: tokenHash,
        purpose,
        expires_at: expiresAt,
        created_by: actor.userId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "credential.issue",
        targetType: "app_user",
        targetId: userId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { reason: purpose },
      });
    });

    return { token, expiresAt: expiresAt.toISOString() };
  }

  async function consumeCredentialToken(
    rawToken: string,
    newPassword: string,
    expectedPurpose: CredentialPurpose,
    requestId: string,
  ): Promise<void> {
    // Argon2id ~250 ms runs BEFORE the transaction: the token row lock is
    // never held while hashing, and invalid tokens pay the same cost as
    // valid ones.
    const passwordHash = await hashPassword(newPassword);
    const tokenHash = hashCredentialToken(rawToken);
    const now = clock();

    const outcome = await db.transaction(async (tx) => {
      const row = (await tx("one_time_token")
        .where({ token_hash: tokenHash })
        .forUpdate()
        .first()) as OneTimeTokenRow | undefined;
      if (!row) return { kind: "invalid" } as const;

      const usable =
        row.purpose === expectedPurpose &&
        row.used_at === null &&
        new Date(row.expires_at).getTime() > now.getTime();
      if (!usable) return { kind: "invalid", row } as const;

      const user = (await tx("app_user")
        .where({ id: row.user_id, company_id: row.company_id })
        .forUpdate()
        .first()) as AuthUserRow | undefined;
      // The token is only consumable while the account is still in the
      // state it was issued for: 'activate' needs a still-pending user,
      // 'reset' a still-active one — a token must never resurrect an
      // account that was deactivated after issuance.
      const statusOk =
        user !== undefined &&
        (expectedPurpose === "activate"
          ? user.status === "pending"
          : user.status === "active");
      if (!statusOk) return { kind: "invalid", row } as const;

      await tx("one_time_token").where({ id: row.id }).update({
        used_at: now,
      });
      await tx("app_user")
        .where({ id: user.id, company_id: user.company_id })
        .update({
          password_hash: passwordHash,
          status: "active",
          auth_version: tx.raw("auth_version + 1"),
        });
      // In-transaction session kill: the revoke commits or rolls back
      // with the credential write — no window where an old session
      // survives a rotated password.
      await revokeAllUserSessionsInTx(
        tx,
        clock,
        user.id,
        requestId,
        expectedPurpose,
      );
      await appendAudit(tx, {
        companyId: user.company_id,
        actorId: user.id,
        action:
          expectedPurpose === "activate"
            ? "credential.activate"
            : "credential.reset",
        targetType: "app_user",
        targetId: user.id,
        outcome: "success",
        requestId,
        metadata: {},
      });
      return { kind: "ok" } as const;
    });

    if (outcome.kind === "invalid") {
      if ("row" in outcome && outcome.row !== undefined) {
        await auditConsumeFailure(outcome.row, requestId);
      }
      throw invalidToken();
    }
  }

  async function changeOwnPassword(
    actor: ActorContext,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    // Read (with password_hash — the auth-repository row carries it; the
    // users-repository DTO deliberately never selects credential material).
    const user = await findAuthUserById(db, actor.companyId, actor.userId);
    const storedHash =
      user && user.status === "active" ? (user.password_hash ?? "") : "";
    const passwordOk =
      storedHash !== "" && (await verifyPassword(storedHash, currentPassword));
    if (!user || user.status !== "active" || !passwordOk) {
      // Constant-ish failure: one generic 400 regardless of which check
      // failed — a wrong current password leaks nothing about the account.
      throw new AppError(
        400,
        "INVALID_CREDENTIALS",
        "Mật khẩu hiện tại không đúng",
      );
    }

    const passwordHash = await hashPassword(newPassword);
    await db.transaction(async (tx) => {
      // Re-read under FOR UPDATE and compare the hash we verified: a
      // concurrent credential change since the pre-read fails closed with
      // the same generic error instead of silently overwriting.
      const locked = (await tx("app_user")
        .where({ id: actor.userId, company_id: actor.companyId })
        .forUpdate()
        .first()) as AuthUserRow | undefined;
      if (
        !locked ||
        locked.status !== "active" ||
        locked.password_hash !== storedHash
      ) {
        throw new AppError(
          400,
          "INVALID_CREDENTIALS",
          "Mật khẩu hiện tại không đúng",
        );
      }
      await tx("app_user")
        .where({ id: actor.userId, company_id: actor.companyId })
        .update({
          password_hash: passwordHash,
          auth_version: tx.raw("auth_version + 1"),
        });
      // ALL sessions die — including the one carrying this request
      // (actor.sessionId). Spec §8: đổi mật khẩu revoke mọi session.
      await revokeAllUserSessionsInTx(
        tx,
        clock,
        actor.userId,
        actor.requestId,
        "password_change",
      );
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "credential.password_change",
        targetType: "app_user",
        targetId: actor.userId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: {},
      });
    });
  }

  return { issueCredentialToken, consumeCredentialToken, changeOwnPassword };
}

export type CredentialsService = ReturnType<typeof createCredentialsService>;
