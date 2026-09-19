import type { Knex } from "knex";

/**
 * Users module row access — thin typed wrappers over Knex (task 1.3). No
 * business rules live here; the service owns authorization, lifecycle and
 * transaction decisions. Every query is scoped by company_id: callers always
 * pass actor.companyId, so a row outside the actor's company is invisible.
 *
 * password_hash is deliberately NOT selected anywhere in this module — the
 * directory DTO must never carry credential material.
 */
export interface UserRow {
  id: string;
  company_id: string;
  email: string;
  name: string;
  title: string | null;
  department_id: string | null;
  team_id: string | null;
  manager_id: string | null;
  status: string;
  created_at: Date;
}

export interface ReportRow {
  id: string;
  status: string;
}

type Qb = Knex | Knex.Transaction;

const USER_COLUMNS = [
  "id",
  "company_id",
  "email",
  "name",
  "title",
  "department_id",
  "team_id",
  "manager_id",
  "status",
  "created_at",
] as const;

export async function findUserById(
  db: Qb,
  companyId: string,
  userId: string,
): Promise<UserRow | undefined> {
  return (await db("app_user")
    .where({ id: userId, company_id: companyId })
    .select(USER_COLUMNS)
    .first()) as UserRow | undefined;
}

/**
 * Lookup via the stored generated column — same normalization the unique
 * constraint app_user_email_unique (company_id, email_normalized) enforces.
 */
export async function findUserIdByEmail(
  db: Qb,
  companyId: string,
  email: string,
): Promise<{ id: string } | undefined> {
  return (await db("app_user")
    .where({ company_id: companyId })
    .whereRaw("email_normalized = lower(btrim(?))", [email])
    .select("id")
    .first()) as { id: string } | undefined;
}

/** Keyset page over id — same convention as the org listings. */
export async function listUsers(
  db: Qb,
  companyId: string,
  opts: { limit: number; cursor?: string },
): Promise<UserRow[]> {
  let q = db("app_user")
    .where({ company_id: companyId })
    .orderBy("id", "asc")
    .limit(opts.limit + 1);
  if (opts.cursor !== undefined) {
    q = q.whereRaw("id > ?::uuid", [opts.cursor]);
  }
  return (await q.select(USER_COLUMNS)) as UserRow[];
}

export async function insertUser(
  tx: Knex.Transaction,
  row: {
    company_id: string;
    email: string;
    name: string;
    title: string | null;
    department_id: string | null;
    team_id: string | null;
    status: string;
  },
): Promise<UserRow> {
  const rows = (await tx("app_user").insert(row, USER_COLUMNS)) as UserRow[];
  return rows[0];
}

export async function updateUser(
  tx: Knex.Transaction,
  companyId: string,
  userId: string,
  patch: {
    name?: string;
    title?: string | null;
    department_id?: string | null;
    team_id?: string | null;
    status?: string;
  },
): Promise<UserRow | undefined> {
  const rows = (await tx("app_user")
    .where({ id: userId, company_id: companyId })
    .update(patch, USER_COLUMNS)) as UserRow[];
  return rows[0];
}

/** Role keys held by one user — fresh read, never cached (spec §4). */
export async function loadUserRoleKeys(
  db: Qb,
  companyId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db("user_role")
    .join("role", "role.id", "user_role.role_id")
    .where({ "user_role.company_id": companyId, "user_role.user_id": userId })
    .select("role.key");
  return rows.map((r: { key: string }) => r.key);
}

/** Roles for a whole page of users in one query — no N+1 on the list route. */
export async function loadRoleKeysForUsers(
  db: Qb,
  companyId: string,
  userIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (userIds.length === 0) return map;
  const rows = await db("user_role")
    .join("role", "role.id", "user_role.role_id")
    .where({ "user_role.company_id": companyId })
    .whereIn("user_role.user_id", userIds)
    .select("user_role.user_id", "role.key");
  for (const row of rows as { user_id: string; key: string }[]) {
    const list = map.get(row.user_id) ?? [];
    list.push(row.key);
    map.set(row.user_id, list);
  }
  return map;
}

/** role.key → role.id for the fixed allowlist seeded by migration 0001. */
export async function roleIdsByKey(db: Qb): Promise<Map<string, string>> {
  const rows = await db("role").select("id", "key");
  return new Map(
    (rows as { id: string; key: string }[]).map((r) => [r.key, r.id]),
  );
}

/**
 * Full-set replace of one user's roles: delete the current rows, insert the
 * new set. Callers serialize on lockCompany and own the last-owner check —
 * this helper only writes what it is told.
 */
export async function replaceUserRoles(
  tx: Knex.Transaction,
  companyId: string,
  userId: string,
  roleIds: string[],
): Promise<void> {
  await tx("user_role").where({ company_id: companyId, user_id: userId }).del();
  if (roleIds.length === 0) return;
  await tx("user_role").insert(
    roleIds.map((role_id) => ({
      company_id: companyId,
      user_id: userId,
      role_id,
    })),
  );
}

/**
 * Number of DISTINCT active users holding the owner role — the denominator
 * of the last-owner invariant (spec §4: the company must always keep at
 * least one ACTIVE owner; a pending/inactive owner does not count).
 */
export async function countActiveOwners(
  db: Qb,
  companyId: string,
): Promise<number> {
  const row = (await db("app_user")
    .join("user_role", function () {
      this.on("user_role.user_id", "=", "app_user.id").andOn(
        "user_role.company_id",
        "=",
        "app_user.company_id",
      );
    })
    .join("role", "role.id", "user_role.role_id")
    .where({
      "app_user.company_id": companyId,
      "app_user.status": "active",
      "role.key": "owner",
    })
    .countDistinct("app_user.id as n")
    .first()) as { n: string | number } | undefined;
  return Number(row?.n ?? 0);
}

/** Every direct report of a manager — any status. */
export async function listDirectReports(
  db: Qb,
  companyId: string,
  managerId: string,
): Promise<ReportRow[]> {
  return (await db("app_user")
    .where({ company_id: companyId, manager_id: managerId })
    .select("id", "status")) as ReportRow[];
}

/**
 * Re-line every direct report of `fromManagerId` onto `toManagerId` (or
 * explicit null → "unassigned"). Runs inside the caller's transaction so the
 * transfer commits or rolls back with the deactivation that caused it.
 */
export async function transferDirectReports(
  tx: Knex.Transaction,
  companyId: string,
  fromManagerId: string,
  toManagerId: string | null,
): Promise<number> {
  const updated = await tx("app_user")
    .where({ company_id: companyId, manager_id: fromManagerId })
    .update({ manager_id: toManagerId });
  return Number(updated);
}
