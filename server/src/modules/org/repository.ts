import type { Knex } from "knex";

/**
 * Org module row access — thin typed wrappers over Knex (task 1.1). No
 * business rules live here; the service owns authorization, archive and
 * transaction decisions. Every query is scoped by company_id: callers always
 * pass actor.companyId, so a row outside the actor's company is invisible.
 */

export interface CompanyRow {
  id: string;
  name: string;
  timezone: string;
  created_at: Date;
}

export interface DepartmentRow {
  id: string;
  company_id: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
}

export interface TeamRow {
  id: string;
  company_id: string;
  department_id: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
}

type Qb = Knex | Knex.Transaction;

export async function findCompanyById(
  db: Qb,
  companyId: string,
): Promise<CompanyRow | undefined> {
  return (await db("company").where({ id: companyId }).first()) as
    | CompanyRow
    | undefined;
}

export async function updateCompanyProfile(
  tx: Knex.Transaction,
  companyId: string,
  patch: { name?: string; timezone?: string },
): Promise<CompanyRow | undefined> {
  const rows = (await tx("company")
    .where({ id: companyId })
    .update(patch, ["id", "name", "timezone", "created_at"])) as CompanyRow[];
  return rows[0];
}

/** Fresh per-request role read — roles are never trusted from the JWT. */
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
 * Keyset pagination over id (stable + unique — org units are small bounded
 * lists). `cursor` is the last id of the previous page; callers fetch
 * limit+1 rows to derive nextCursor.
 */
export async function listDepartments(
  db: Qb,
  companyId: string,
  opts: { limit: number; cursor?: string },
): Promise<DepartmentRow[]> {
  let q = db("department")
    .where({ company_id: companyId })
    .orderBy("id", "asc")
    .limit(opts.limit + 1);
  if (opts.cursor !== undefined) {
    q = q.whereRaw("id > ?::uuid", [opts.cursor]);
  }
  return (await q.select()) as DepartmentRow[];
}

export async function findDepartmentById(
  db: Qb,
  companyId: string,
  id: string,
): Promise<DepartmentRow | undefined> {
  return (await db("department")
    .where({ id, company_id: companyId })
    .first()) as DepartmentRow | undefined;
}

export async function insertDepartment(
  tx: Knex.Transaction,
  row: { company_id: string; name: string },
): Promise<DepartmentRow> {
  const rows = (await tx("department").insert(row, [
    "id",
    "company_id",
    "name",
    "archived_at",
    "created_at",
  ])) as DepartmentRow[];
  return rows[0];
}

export async function updateDepartmentName(
  tx: Knex.Transaction,
  companyId: string,
  id: string,
  name: string,
): Promise<DepartmentRow | undefined> {
  const rows = (await tx("department")
    .where({ id, company_id: companyId })
    .update({ name }, [
      "id",
      "company_id",
      "name",
      "archived_at",
      "created_at",
    ])) as DepartmentRow[];
  return rows[0];
}

export async function markDepartmentArchived(
  tx: Knex.Transaction,
  companyId: string,
  id: string,
  at: Date,
): Promise<void> {
  await tx("department")
    .where({ id, company_id: companyId })
    .update({ archived_at: at });
}

/** One referencing user is enough to block archive — LIMIT 1 existence. */
export async function departmentHasUsers(
  db: Qb,
  companyId: string,
  departmentId: string,
): Promise<boolean> {
  const row = await db("app_user")
    .where({ company_id: companyId, department_id: departmentId })
    .select("id")
    .first();
  return row !== undefined;
}

/**
 * One live (non-archived) child team is enough to block a department
 * archive — archived teams do not block; LIMIT 1 existence.
 */
export async function departmentHasActiveTeams(
  db: Qb,
  companyId: string,
  departmentId: string,
): Promise<boolean> {
  const row = await db("team")
    .where({ company_id: companyId, department_id: departmentId })
    .whereNull("archived_at")
    .select("id")
    .first();
  return row !== undefined;
}

export async function listTeams(
  db: Qb,
  companyId: string,
  opts: { limit: number; cursor?: string; departmentId?: string },
): Promise<TeamRow[]> {
  let q = db("team")
    .where({ company_id: companyId })
    .orderBy("id", "asc")
    .limit(opts.limit + 1);
  if (opts.cursor !== undefined) {
    q = q.whereRaw("id > ?::uuid", [opts.cursor]);
  }
  if (opts.departmentId !== undefined) {
    q = q.where({ department_id: opts.departmentId });
  }
  return (await q.select()) as TeamRow[];
}

export async function findTeamById(
  db: Qb,
  companyId: string,
  id: string,
): Promise<TeamRow | undefined> {
  return (await db("team")
    .where({ id, company_id: companyId })
    .first()) as TeamRow | undefined;
}

export async function insertTeam(
  tx: Knex.Transaction,
  row: { company_id: string; department_id: string; name: string },
): Promise<TeamRow> {
  const rows = (await tx("team").insert(row, [
    "id",
    "company_id",
    "department_id",
    "name",
    "archived_at",
    "created_at",
  ])) as TeamRow[];
  return rows[0];
}

export async function updateTeam(
  tx: Knex.Transaction,
  companyId: string,
  id: string,
  patch: { name?: string; department_id?: string },
): Promise<TeamRow | undefined> {
  const rows = (await tx("team")
    .where({ id, company_id: companyId })
    .update(patch, [
      "id",
      "company_id",
      "department_id",
      "name",
      "archived_at",
      "created_at",
    ])) as TeamRow[];
  return rows[0];
}

export async function markTeamArchived(
  tx: Knex.Transaction,
  companyId: string,
  id: string,
  at: Date,
): Promise<void> {
  await tx("team")
    .where({ id, company_id: companyId })
    .update({ archived_at: at });
}

export async function teamHasUsers(
  db: Qb,
  companyId: string,
  teamId: string,
): Promise<boolean> {
  const row = await db("app_user")
    .where({ company_id: companyId, team_id: teamId })
    .select("id")
    .first();
  return row !== undefined;
}
