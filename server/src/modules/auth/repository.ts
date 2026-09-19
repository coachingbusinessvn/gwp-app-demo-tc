import type { Knex } from "knex";

/**
 * Auth module row access — thin typed wrappers over Knex. No business rules
 * live here; the service owns session/rotation decisions. All queries run on
 * the least-privilege runtime credential.
 */

export interface UserRow {
  id: string;
  company_id: string;
  email: string;
  name: string;
  title: string | null;
  password_hash: string | null;
  manager_id: string | null;
  status: string;
}

export interface SessionRow {
  id: string;
  company_id: string;
  user_id: string;
  token_family_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface RefreshTokenRow {
  id: string;
  session_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  replaced_by: string | null;
}

type Qb = Knex | Knex.Transaction;

/** Lookup via the stored generated column — same normalization as the DB. */
export async function findUserByEmail(
  db: Qb,
  email: string,
): Promise<UserRow | undefined> {
  return (await db("app_user")
    .whereRaw("email_normalized = lower(btrim(?))", [email])
    .first()) as UserRow | undefined;
}

export async function findUserById(
  db: Qb,
  companyId: string,
  userId: string,
): Promise<UserRow | undefined> {
  return (await db("app_user")
    .where({ id: userId, company_id: companyId })
    .first()) as UserRow | undefined;
}

export async function findSessionById(
  db: Qb,
  id: string,
  forUpdate = false,
): Promise<SessionRow | undefined> {
  let q = db("auth_session").where({ id });
  if (forUpdate) q = q.forUpdate();
  return (await q.first()) as SessionRow | undefined;
}

export async function findTokenByHash(
  db: Qb,
  tokenHash: string,
): Promise<RefreshTokenRow | undefined> {
  return (await db("refresh_token")
    .where({ token_hash: tokenHash })
    .first()) as RefreshTokenRow | undefined;
}

export async function findTokenByHashForUpdate(
  tx: Knex.Transaction,
  tokenHash: string,
): Promise<RefreshTokenRow | undefined> {
  return (await tx("refresh_token")
    .where({ token_hash: tokenHash })
    .forUpdate()
    .first()) as RefreshTokenRow | undefined;
}

export async function insertSession(
  tx: Knex.Transaction,
  row: {
    id: string;
    company_id: string;
    user_id: string;
    token_family_id: string;
    expires_at: Date;
  },
): Promise<void> {
  await tx("auth_session").insert(row);
}

export async function insertRefreshToken(
  tx: Knex.Transaction,
  row: {
    id: string;
    session_id: string;
    token_hash: string;
    expires_at: Date;
  },
): Promise<void> {
  await tx("refresh_token").insert(row);
}

export async function markTokenConsumed(
  tx: Knex.Transaction,
  tokenId: string,
  replacedBy: string,
  at: Date,
): Promise<void> {
  await tx("refresh_token")
    .where({ id: tokenId })
    .update({ consumed_at: at, replaced_by: replacedBy });
}

export async function markSessionRevoked(
  db: Qb,
  sessionId: string,
  at: Date,
): Promise<void> {
  await db("auth_session").where({ id: sessionId }).update({ revoked_at: at });
}

/** Every live (non-revoked) session of a user, locked FOR UPDATE. */
export async function findActiveSessionsByUser(
  tx: Knex.Transaction,
  userId: string,
): Promise<SessionRow[]> {
  return (await tx("auth_session")
    .where({ user_id: userId })
    .whereNull("revoked_at")
    .forUpdate()
    .select()) as SessionRow[];
}

export async function markSessionsRevoked(
  tx: Knex.Transaction,
  sessionIds: string[],
  at: Date,
): Promise<void> {
  await tx("auth_session")
    .whereIn("id", sessionIds)
    .update({ revoked_at: at });
}

/** Fresh per-request role read — roles never ride in the JWT (spec §4/§8). */
export async function loadRoleKeys(
  db: Qb,
  companyId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db("user_role")
    .join("role", "role.id", "user_role.role_id")
    .where({ "user_role.company_id": companyId, "user_role.user_id": userId })
    .orderBy("role.key")
    .select("role.key");
  return rows.map((r: { key: string }) => r.key);
}
