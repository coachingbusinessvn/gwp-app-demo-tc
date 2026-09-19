import type { Knex } from "knex";
import type {
  ActorContext,
  Clock,
  Id,
  Page,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { appendAudit } from "../audit/service.js";
import {
  departmentHasUsers,
  findCompanyById,
  findDepartmentById,
  findTeamById,
  insertDepartment,
  insertTeam,
  listDepartments,
  listTeams,
  loadActorRoles,
  markDepartmentArchived,
  markTeamArchived,
  teamHasUsers,
  updateCompanyProfile,
  updateDepartmentName,
  updateTeam,
  type DepartmentRow,
  type TeamRow,
} from "./repository.js";

/**
 * Org administration (task 1.1, spec §3/§4).
 *
 * - One deployment = one company: there is no company-create path here or at
 *   the route layer; the only writable company surface is the profile PATCH.
 * - Mutations (create/update/archive + company PATCH) are owner+admin only.
 *   Roles are re-read from the DB inside the transaction — never from the
 *   JWT — and every mutation serializes on lockCompany + writes its audit
 *   row in the same transaction (commit or rollback together).
 * - Archive is a flag, never a delete: a unit still referenced by app_user
 *   returns 409 ORG_UNIT_IN_USE (members must be transferred first); an
 *   unreferenced unit gets archived_at and keeps all historical FKs.
 * - Reads (company profile, department/team lists) are open to every
 *   authenticated member of the company — the §4 matrix restricts
 *   configuration, not org metadata.
 */

export interface CompanyDto {
  id: Id;
  name: string;
  timezone: string;
  createdAt: string;
}

export interface DepartmentDto {
  id: Id;
  name: string;
  archivedAt: string | null;
}

export interface TeamDto {
  id: Id;
  departmentId: Id;
  name: string;
  archivedAt: string | null;
}

export type OrgUnitKind = "department" | "team";

function toIso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toCompanyDto(row: {
  id: string;
  name: string;
  timezone: string;
  created_at: Date | string;
}): CompanyDto {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toDepartmentDto(row: DepartmentRow): DepartmentDto {
  return { id: row.id, name: row.name, archivedAt: toIso(row.archived_at) };
}

function toTeamDto(row: TeamRow): TeamDto {
  return {
    id: row.id,
    departmentId: row.department_id,
    name: row.name,
    archivedAt: toIso(row.archived_at),
  };
}

function notFound(): AppError {
  // Consistent 404 for missing/cross-company/forged ids (spec §2).
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

export interface OrgDeps {
  db: Knex;
  clock: Clock;
}

export function createOrgService({ db, clock }: OrgDeps) {
  /**
   * owner+admin gate for org mutations. Runs inside the mutation's
   * transaction (after lockCompany) so the role read is current and the
   * whole decision serializes with the write.
   */
  async function requireOrgAdmin(
    tx: Knex.Transaction,
    actor: ActorContext,
  ): Promise<void> {
    const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
    if (!roles.includes("owner") && !roles.includes("admin")) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Chỉ owner hoặc admin được quản trị tổ chức",
      );
    }
  }

  async function getCompany(actor: ActorContext): Promise<CompanyDto> {
    const row = await findCompanyById(db, actor.companyId);
    if (!row) throw notFound();
    return toCompanyDto(row);
  }

  async function updateCompany(
    actor: ActorContext,
    patch: { name?: string; timezone?: string },
  ): Promise<CompanyDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireOrgAdmin(tx, actor);
      const updated = await updateCompanyProfile(tx, actor.companyId, patch);
      if (!updated) throw notFound();
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "org.company.update",
        targetType: "company",
        targetId: actor.companyId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { field: Object.keys(patch).join(",") },
      });
      return toCompanyDto(updated);
    });
  }

  async function listDepartmentPage(
    actor: ActorContext,
    opts: { limit: number; cursor?: string },
  ): Promise<Page<DepartmentDto>> {
    const rows = await listDepartments(db, actor.companyId, opts);
    const items = rows.slice(0, opts.limit).map(toDepartmentDto);
    return {
      items,
      nextCursor: rows.length > opts.limit ? items[items.length - 1].id : null,
    };
  }

  async function createDepartment(
    actor: ActorContext,
    input: { name: string },
  ): Promise<DepartmentDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireOrgAdmin(tx, actor);
      const row = await insertDepartment(tx, {
        company_id: actor.companyId,
        name: input.name,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "org.department.create",
        targetType: "department",
        targetId: row.id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: {},
      });
      return toDepartmentDto(row);
    });
  }

  async function updateDepartment(
    actor: ActorContext,
    id: Id,
    input: { name: string },
  ): Promise<DepartmentDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireOrgAdmin(tx, actor);
      const existing = await findDepartmentById(tx, actor.companyId, id);
      if (!existing) throw notFound();
      const row = await updateDepartmentName(tx, actor.companyId, id, input.name);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "org.department.update",
        targetType: "department",
        targetId: id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { field: "name" },
      });
      return toDepartmentDto(row!);
    });
  }

  async function listTeamPage(
    actor: ActorContext,
    opts: { limit: number; cursor?: string; departmentId?: string },
  ): Promise<Page<TeamDto>> {
    const rows = await listTeams(db, actor.companyId, opts);
    const items = rows.slice(0, opts.limit).map(toTeamDto);
    return {
      items,
      nextCursor: rows.length > opts.limit ? items[items.length - 1].id : null,
    };
  }

  /** A team target must be a live department of this company. */
  async function requireActiveDepartment(
    tx: Knex.Transaction,
    companyId: Id,
    departmentId: Id,
  ): Promise<DepartmentRow> {
    const dep = await findDepartmentById(tx, companyId, departmentId);
    if (!dep) {
      throw new AppError(404, "NOT_FOUND", "Không tìm thấy phòng ban");
    }
    if (dep.archived_at !== null) {
      throw new AppError(
        409,
        "ORG_UNIT_ARCHIVED",
        "Phòng ban đã lưu trữ — không thể gán tổ",
      );
    }
    return dep;
  }

  async function createTeam(
    actor: ActorContext,
    input: { departmentId: Id; name: string },
  ): Promise<TeamDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireOrgAdmin(tx, actor);
      await requireActiveDepartment(tx, actor.companyId, input.departmentId);
      const row = await insertTeam(tx, {
        company_id: actor.companyId,
        department_id: input.departmentId,
        name: input.name,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "org.team.create",
        targetType: "team",
        targetId: row.id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: {},
      });
      return toTeamDto(row);
    });
  }

  async function updateTeamById(
    actor: ActorContext,
    id: Id,
    patch: { name?: string; departmentId?: Id },
  ): Promise<TeamDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireOrgAdmin(tx, actor);
      const existing = await findTeamById(tx, actor.companyId, id);
      if (!existing) throw notFound();
      if (patch.departmentId !== undefined) {
        await requireActiveDepartment(tx, actor.companyId, patch.departmentId);
      }
      const fields: string[] = [];
      const row = await updateTeam(tx, actor.companyId, id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.departmentId !== undefined
          ? { department_id: patch.departmentId }
          : {}),
      });
      if (patch.name !== undefined) fields.push("name");
      if (patch.departmentId !== undefined) fields.push("departmentId");
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "org.team.update",
        targetType: "team",
        targetId: id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { field: fields.join(",") },
      });
      return toTeamDto(row!);
    });
  }

  /**
   * Archive one unit. Referenced by any app_user row → 409 ORG_UNIT_IN_USE
   * (transfer members first; there is deliberately no cascade). Unreferenced
   * → archived_at set; the row, its FKs and the audit trail all survive.
   * Re-archiving an already-archived unit is an idempotent no-op returning
   * the unit as-is.
   */
  async function archiveOrgUnit(
    actor: ActorContext,
    kind: OrgUnitKind,
    id: Id,
  ): Promise<DepartmentDto | TeamDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireOrgAdmin(tx, actor);

      const unit =
        kind === "department"
          ? await findDepartmentById(tx, actor.companyId, id)
          : await findTeamById(tx, actor.companyId, id);
      if (!unit) throw notFound();
      if (unit.archived_at !== null) {
        return kind === "department"
          ? toDepartmentDto(unit as DepartmentRow)
          : toTeamDto(unit as TeamRow);
      }

      const inUse =
        kind === "department"
          ? await departmentHasUsers(tx, actor.companyId, id)
          : await teamHasUsers(tx, actor.companyId, id);
      if (inUse) {
        throw new AppError(
          409,
          "ORG_UNIT_IN_USE",
          "Đơn vị đang được tham chiếu — chuyển thành viên trước khi lưu trữ",
        );
      }

      const at = clock();
      if (kind === "department") {
        await markDepartmentArchived(tx, actor.companyId, id, at);
      } else {
        await markTeamArchived(tx, actor.companyId, id, at);
      }
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: `org.${kind}.archive`,
        targetType: kind,
        targetId: id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { status: "archived" },
      });
      const archived = { ...unit, archived_at: at };
      return kind === "department"
        ? toDepartmentDto(archived as DepartmentRow)
        : toTeamDto(archived as TeamRow);
    });
  }

  return {
    getCompany,
    updateCompany,
    listDepartments: listDepartmentPage,
    createDepartment,
    updateDepartment,
    listTeams: listTeamPage,
    createTeam,
    updateTeam: updateTeamById,
    archiveOrgUnit,
  };
}

export type OrgService = ReturnType<typeof createOrgService>;
