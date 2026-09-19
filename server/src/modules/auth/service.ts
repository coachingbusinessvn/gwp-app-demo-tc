import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type {
  ActorContext,
  Clock,
  Id,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { appendAudit } from "../audit/service.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  findSessionById,
  findTokenByHash,
  findTokenByHashForUpdate,
  findUserByEmail,
  findUserById,
  insertRefreshToken,
  insertSession,
  loadRoleKeys,
  markSessionRevoked,
  markTokenConsumed,
  type RefreshTokenRow,
  type SessionRow,
  type UserRow,
} from "./repository.js";

/**
 * Session auth (spec §8): short-lived HS256 access JWT (iss/aud/sub/sid/jti —
 * no role claims; permissions are re-checked from the DB on every request) +
 * a rotating 256-bit refresh token stored only as its SHA-256 hash.
 *
 * Rotation is atomic: the token row is locked FOR UPDATE, a consumed token is
 * treated as reuse → the whole session (token family) is revoked and the
 * revocation COMMITS before the caller sees 401. Concurrent rotations of the
 * same token therefore produce exactly one winner.
 */
export interface AuthDeps {
  db: Knex;
  clock: Clock;
  config: Config;
}

export interface PublicUser {
  id: Id;
  name: string;
  email: string;
  title: string | null;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  user: PublicUser;
}

export interface RotateResult {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 256-bit opaque refresh token — only its SHA-256 hash ever reaches the DB. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Deterministic SHA-256 hex digest; the raw token is never stored or logged. */
export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

function invalidSession(): AppError {
  return new AppError(401, "INVALID_SESSION", "Phiên không hợp lệ");
}

// One real argon2id digest computed lazily per process; unknown-user logins
// verify against it so bad-email and bad-password cost the same ~250 ms and
// return the same generic 401.
let dummyHashPromise: Promise<string> | undefined;
function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("dummy-password-for-timing-uniformity");
  return dummyHashPromise;
}

export function createAuthService({ db, clock, config }: AuthDeps) {
  function signAccessToken(userId: Id, sessionId: Id): string {
    return jwt.sign({ sid: sessionId }, config.jwtSecret, {
      algorithm: "HS256",
      issuer: "gwp",
      audience: "gwp-web",
      subject: userId,
      jwtid: randomUUID(),
      expiresIn: config.accessTokenTtlSeconds,
    });
  }

  /**
   * Best-effort failure audit. Never throws — a failing audit must not mask
   * the real 401. Unknown-email failures attach to the singleton company when
   * one exists (audit_event.company_id is NOT NULL); pre-setup there is
   * nothing to attach to and the event is skipped.
   */
  async function auditLoginFailure(
    user: UserRow | null,
    requestId: string,
  ): Promise<void> {
    try {
      const companyId =
        user?.company_id ??
        ((await db("company").select("id").first()) as { id: string } | undefined)
          ?.id;
      if (!companyId) return;
      await db.transaction(async (tx) => {
        await appendAudit(tx, {
          companyId,
          action: "auth.login",
          targetType: user ? "app_user" : undefined,
          targetId: user?.id,
          outcome: "failure",
          requestId,
          metadata: { error_code: "invalid_credentials" },
        });
      });
    } catch (err) {
      console.error("auth login failure audit failed:", err);
    }
  }

  async function login(
    email: string,
    password: string,
    requestId: string,
  ): Promise<LoginResult> {
    const user = await findUserByEmail(db, email);
    // Uniform timing: exactly one argon2id verify on every path.
    const digest = user?.password_hash ?? (await dummyPasswordHash());
    const passwordOk = await verifyPassword(digest, password);
    if (!user || user.status !== "active" || !passwordOk) {
      await auditLoginFailure(user ?? null, requestId);
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Email hoặc mật khẩu không đúng",
      );
    }

    const sessionId = randomUUID();
    const refreshRaw = generateRefreshToken();
    const sessionExpires = new Date(
      clock().getTime() + config.refreshTokenTtlSeconds * 1000,
    );
    await db.transaction(async (tx) => {
      await insertSession(tx, {
        id: sessionId,
        company_id: user.company_id,
        user_id: user.id,
        token_family_id: randomUUID(),
        expires_at: sessionExpires,
      });
      await insertRefreshToken(tx, {
        id: randomUUID(),
        session_id: sessionId,
        token_hash: hashRefreshToken(refreshRaw),
        expires_at: sessionExpires,
      });
      await appendAudit(tx, {
        companyId: user.company_id,
        actorId: user.id,
        action: "auth.login",
        targetType: "app_user",
        targetId: user.id,
        outcome: "success",
        requestId,
        metadata: {},
      });
    });

    return {
      accessToken: signAccessToken(user.id, sessionId),
      refreshToken: refreshRaw,
      csrfToken: generateCsrfToken(),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
      },
    };
  }

  /**
   * Consume + replace inside the caller's transaction. Returns the token
   * pair on success, {kind:"invalid"} for expired token / revoked or expired
   * session / inactive user.
   */
  async function rotateValidToken(
    tx: Knex.Transaction,
    token: RefreshTokenRow,
  ): Promise<
    | { kind: "invalid" }
    | { kind: "ok"; accessToken: string; refreshToken: string }
  > {
    const now = clock();
    if (new Date(token.expires_at).getTime() <= now.getTime())
      return { kind: "invalid" } as const;
    const session = await findSessionById(tx, token.session_id, true);
    if (
      !session ||
      session.revoked_at ||
      new Date(session.expires_at).getTime() <= now.getTime()
    )
      return { kind: "invalid" } as const;
    const user = await findUserById(tx, session.company_id, session.user_id);
    if (!user || user.status !== "active")
      return { kind: "invalid" } as const;

    const replacementId = randomUUID();
    const replacementRaw = generateRefreshToken();
    // Insert BEFORE marking consumed: replaced_by is a real FK to
    // refresh_token(id), so the target row must exist in this transaction.
    await insertRefreshToken(tx, {
      id: replacementId,
      session_id: session.id,
      token_hash: hashRefreshToken(replacementRaw),
      // Absolute cap: the session expiry set at login — rotation never
      // extends the 7-day refresh window (spec §8).
      expires_at: session.expires_at,
    });
    await markTokenConsumed(tx, token.id, replacementId, now);
    return {
      kind: "ok",
      accessToken: signAccessToken(user.id, session.id),
      refreshToken: replacementRaw,
    } as const;
  }

  async function rotate(
    raw: string,
    requestId: string,
  ): Promise<RotateResult> {
    const outcome = await db.transaction(async (tx) => {
      const token = await findTokenByHashForUpdate(tx, hashRefreshToken(raw));
      if (!token) return { kind: "invalid" } as const;
      if (token.consumed_at) {
        const session = await findSessionById(tx, token.session_id);
        await markSessionRevoked(tx, token.session_id, clock());
        if (session) {
          await appendAudit(tx, {
            companyId: session.company_id,
            actorId: session.user_id,
            action: "auth.refresh",
            targetType: "auth_session",
            targetId: session.id,
            outcome: "failure",
            requestId,
            metadata: { reason: "reused_refresh_token" },
          });
        }
        return { kind: "reuse" } as const; // COMMIT, không throw bên trong
      }
      // Kiểm expires/session/user; consume token và insert replacement trong tx.
      return rotateValidToken(tx, token); // private helper cùng file, trả token pair
    });
    if (outcome.kind !== "ok")
      throw new AppError(401, "INVALID_SESSION", "Phiên không hợp lệ");
    return {
      accessToken: outcome.accessToken,
      refreshToken: outcome.refreshToken,
      csrfToken: generateCsrfToken(),
    };
  }

  /** Revoke one session (logout, deactivate, password change, recovery). */
  async function revokeSession(
    sessionId: Id,
    requestId: string = randomUUID(),
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const session = await findSessionById(tx, sessionId, true);
      if (!session || session.revoked_at) return;
      await markSessionRevoked(tx, session.id, clock());
      await appendAudit(tx, {
        companyId: session.company_id,
        actorId: session.user_id,
        action: "auth.logout",
        targetType: "auth_session",
        targetId: session.id,
        outcome: "success",
        requestId,
        metadata: {},
      });
    });
  }

  /** Logout path: resolve the presented refresh token to its session. */
  async function revokeByRefreshToken(
    raw: string,
    requestId: string,
  ): Promise<void> {
    const token = await findTokenByHash(db, hashRefreshToken(raw));
    if (!token) return;
    await revokeSession(token.session_id, requestId);
  }

  /**
   * Bearer → ActorContext. Every check hits the DB — no cached roles, no
   * trusted claims beyond identity: signature+iss+aud+exp, then session
   * revoked/expired, then user still active (spec §4/§8).
   */
  async function authenticate(
    access: string,
    requestId: string = randomUUID(),
  ): Promise<ActorContext> {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(access, config.jwtSecret, {
        algorithms: ["HS256"],
        issuer: "gwp",
        audience: "gwp-web",
      }) as JwtPayload;
    } catch {
      throw invalidSession();
    }
    const sid = payload.sid;
    if (
      typeof payload.sub !== "string" ||
      typeof sid !== "string" ||
      !UUID_RE.test(payload.sub) ||
      !UUID_RE.test(sid)
    )
      throw invalidSession();

    const session = (await findSessionById(db, sid)) as SessionRow | undefined;
    if (
      !session ||
      session.revoked_at ||
      new Date(session.expires_at).getTime() <= clock().getTime() ||
      session.user_id !== payload.sub
    )
      throw invalidSession();

    const user = await findUserById(db, session.company_id, session.user_id);
    if (!user || user.status !== "active") throw invalidSession();

    return {
      userId: user.id,
      companyId: session.company_id,
      sessionId: session.id,
      requestId,
    };
  }

  /** GET /me payload: profile + roles read fresh from the DB. */
  async function loadProfile(
    actor: ActorContext,
  ): Promise<{ user: PublicUser; roles: string[] }> {
    const user = await findUserById(db, actor.companyId, actor.userId);
    if (!user || user.status !== "active") throw invalidSession();
    const roles = await loadRoleKeys(db, actor.companyId, actor.userId);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
      },
      roles,
    };
  }

  return {
    login,
    rotate,
    revokeSession,
    revokeByRefreshToken,
    authenticate,
    loadProfile,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
