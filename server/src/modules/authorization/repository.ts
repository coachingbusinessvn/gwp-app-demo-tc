import type { Knex } from "knex";

/**
 * Authorization module row access (task 1.2) — thin typed wrappers over
 * Knex. No business rules live here; the subject policy and the reporting
 * service own every decision. All queries are scoped by company_id so a row
 * outside the actor's company is invisible.
 */

export interface SubjectUserRow {
  id: string;
  company_id: string;
  status: string;
  manager_id: string | null;
}

type Qb = Knex | Knex.Transaction;

/** One user inside one company — the subject/actor/target lookup shape. */
export async function findCompanyUser(
  db: Qb,
  companyId: string,
  userId: string,
): Promise<SubjectUserRow | undefined> {
  return (await db("app_user")
    .where({ id: userId, company_id: companyId })
    .select("id", "company_id", "status", "manager_id")
    .first()) as SubjectUserRow | undefined;
}

/**
 * Fresh per-use role read — roles are never cached on the ActorContext or
 * trusted from the JWT (spec §4/§8). This is the shared home for that read;
 * org/repository keeps its own copy until a later cleanup.
 */
export async function loadActorRoles(
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

/**
 * Every user id in rootUserId's reporting subtree (root included) — the
 * recursive walk over app_user.manager_id from spec §3, with the `visited`
 * array path so a cycle already sitting in the table (dirty data) makes the
 * walk terminate instead of looping forever.
 */
export async function listSubtreeUserIds(
  db: Qb,
  companyId: string,
  rootUserId: string,
): Promise<string[]> {
  const result = await db.raw(
    `WITH RECURSIVE descendants AS (
       SELECT id, ARRAY[id] AS visited
       FROM app_user
       WHERE id = ? AND company_id = ?
       UNION ALL
       SELECT u.id, d.visited || u.id
       FROM app_user u
       JOIN descendants d ON u.manager_id = d.id
       WHERE u.company_id = ? AND NOT u.id = ANY(d.visited)
     )
     SELECT id FROM descendants`,
    [rootUserId, companyId, companyId],
  );
  return (result.rows as { id: string }[]).map((r) => r.id);
}

/** Every user id of the company — the owner scope. */
export async function listCompanyUserIds(
  db: Qb,
  companyId: string,
): Promise<string[]> {
  const rows = await db("app_user")
    .where({ company_id: companyId })
    .select("id");
  return rows.map((r: { id: string }) => r.id);
}

/** Rewrite one user's reporting line; returns the row after the update. */
export async function updateManagerId(
  tx: Knex.Transaction,
  companyId: string,
  userId: string,
  managerId: string | null,
): Promise<SubjectUserRow | undefined> {
  const rows = (await tx("app_user")
    .where({ id: userId, company_id: companyId })
    .update({ manager_id: managerId }, [
      "id",
      "company_id",
      "status",
      "manager_id",
    ])) as SubjectUserRow[];
  return rows[0];
}
