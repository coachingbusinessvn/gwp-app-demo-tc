import type { Knex } from "knex";
import type {
  ActorContext,
  Clock,
  Id,
  Page,
  Role,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { appendAudit } from "../audit/service.js";
import { findDepartmentById, findTeamById } from "../org/repository.js";
import {
  listSubtreeUserIds,
  loadActorRoles,
} from "../authorization/repository.js";
import {
  countActiveOwners,
  findUserById,
  findUserIdByEmail,
  insertUser,
  listDirectReports,
  listUsers,
  loadRoleKeysForUsers,
  loadUserRoleKeys,
  replaceUserRoles,
  roleIdsByKey,
  transferDirectReports,
  updateUser,
  userHasPassword,
  type UserRow,
} from "./repository.js";

/**
 * User administration (task 1.3, spec §3/§4/§8).
 *
 * - PUT roles is OWNER ONLY — even admin cannot touch roles, not even its
 *   own. The set is a full replace over {owner,admin,manager,member};
 *   roles are re-read from the DB inside the transaction, never the JWT.
 * - The last-owner invariant is enforced under lockCompany: removing the
 *   owner role from — or deactivating — the last ACTIVE owner returns 409
 *   LAST_OWNER, and concurrent attempts serialize so exactly one wins.
 * - Deactivation asymmetry (spec §4): admin may deactivate plain members
 *   only — never owner/admin accounts, and never a user who still has
 *   direct reports of ANY status (that would reshape the tree — owner
 *   territory, and §3's manager_id rules are not status-qualified). The
 *   owner must decide the reports' new line in the SAME transaction:
 *   replacementManagerId transfers them, explicit null unassigns.
 * - Every deactivation is followed by revokeAllUserSessions — durable
 *   session kill on top of authenticate()'s per-request status check.
 * - Users are never hard-deleted: status flips to inactive, every
 *   historical FK (manager, department, team, authorship) survives.
 * - Reactivation is the inverse transition, inactive → active|pending,
 *   with the same owner/admin asymmetry (see reactivateUser).
 */
export interface UserDto {
  id: Id;
  email: string;
  name: string;
  title: string | null;
  departmentId: Id | null;
  teamId: Id | null;
  managerId: Id | null;
  status: string;
  roles: string[];
  createdAt: string;
}

function toUserDto(row: UserRow, roles: string[]): UserDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    departmentId: row.department_id,
    teamId: row.team_id,
    managerId: row.manager_id,
    status: row.status,
    roles: roles.slice().sort(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function notFound(): AppError {
  // Consistent 404 for missing/cross-company/forged ids (spec §2).
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

export interface UsersDeps {
  db: Knex;
  clock: Clock;
  /**
   * Durable session kill — auth.service's revokeAllUserSessions. It owns a
   * standalone transaction (its signature predates this module), so the
   * deactivation calls it immediately AFTER the mutation commits: the
   * status flip is already durable, and authenticate()'s status check
   * covers the gap; the revoke write makes it permanent even across a
   * later reactivation.
   */
  revokeAllUserSessions: (
    userId: Id,
    requestId?: string,
    reason?: string,
  ) => Promise<number>;
}

export function createUsersService({ db, revokeAllUserSessions }: UsersDeps) {
  /** Defense in depth behind authenticate(): the actor must still be active. */
  async function requireActiveActor(
    tx: Knex.Transaction,
    actor: ActorContext,
  ): Promise<void> {
    const me = await findUserById(tx, actor.companyId, actor.userId);
    if (!me || me.status !== "active") {
      throw new AppError(403, "FORBIDDEN", "Tài khoản không hoạt động");
    }
  }

  async function requireOwnerOrAdmin(
    tx: Knex.Transaction,
    actor: ActorContext,
  ): Promise<{ isOwner: boolean }> {
    const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
    const isOwner = roles.includes("owner");
    if (!isOwner && !roles.includes("admin")) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Chỉ owner hoặc admin được quản trị tài khoản",
      );
    }
    return { isOwner };
  }

  /**
   * Resolve the (department, team) assignment for a create/patch against
   * the CURRENT row. teamId pins the department to the team's own — the
   * composite FK app_user_team_fk (company_id, department_id, team_id)
   * makes any other pairing a constraint violation, and a contradicting
   * departmentId is rejected as 400 instead of relying on that. Units must
   * exist in the company (404) and be live — FKs alone don't check
   * archived_at (409 ORG_UNIT_ARCHIVED, task-1.1 carry-forward).
   */
  async function resolveOrgAssignment(
    tx: Knex.Transaction,
    companyId: Id,
    input: {
      departmentId?: string | null;
      teamId?: string | null;
    },
    current: { department_id: string | null; team_id: string | null },
  ): Promise<{ department_id: string | null; team_id: string | null }> {
    let departmentId =
      input.departmentId === undefined
        ? current.department_id
        : input.departmentId;
    const teamId =
      input.teamId === undefined ? current.team_id : input.teamId;

    if (teamId !== null) {
      const team = await findTeamById(tx, companyId, teamId);
      if (!team) {
        throw new AppError(404, "NOT_FOUND", "Không tìm thấy tổ");
      }
      if (team.archived_at !== null) {
        throw new AppError(
          409,
          "ORG_UNIT_ARCHIVED",
          "Tổ đã lưu trữ — không thể gán thành viên",
        );
      }
      const department = await findDepartmentById(
        tx,
        companyId,
        team.department_id,
      );
      if (!department || department.archived_at !== null) {
        throw new AppError(
          409,
          "ORG_UNIT_ARCHIVED",
          "Phòng ban đã lưu trữ — không thể gán tổ",
        );
      }
      if (
        input.departmentId !== undefined &&
        input.departmentId !== team.department_id
      ) {
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Tổ không thuộc phòng ban đã chọn",
          { fields: ["departmentId", "teamId"] },
        );
      }
      departmentId = team.department_id;
    } else if (departmentId !== null) {
      const department = await findDepartmentById(tx, companyId, departmentId);
      if (!department) {
        throw new AppError(404, "NOT_FOUND", "Không tìm thấy phòng ban");
      }
      if (department.archived_at !== null) {
        throw new AppError(
          409,
          "ORG_UNIT_ARCHIVED",
          "Phòng ban đã lưu trữ — không thể gán thành viên",
        );
      }
    }
    return { department_id: departmentId, team_id: teamId };
  }

  /**
   * Guard for the last-owner invariant, read under the company lock AFTER
   * any concurrent winner has committed: the operation may not leave the
   * company with zero ACTIVE owners.
   */
  async function assertNotLastOwner(
    tx: Knex.Transaction,
    companyId: Id,
  ): Promise<void> {
    const owners = await countActiveOwners(tx, companyId);
    if (owners <= 1) {
      throw new AppError(
        409,
        "LAST_OWNER",
        "Không thể bỏ owner hoạt động cuối cùng",
      );
    }
  }

  async function listUserPage(
    actor: ActorContext,
    opts: { limit: number; cursor?: string },
  ): Promise<Page<UserDto>> {
    const rows = await listUsers(db, actor.companyId, opts);
    const items = rows.slice(0, opts.limit);
    const rolesByUser = await loadRoleKeysForUsers(
      db,
      actor.companyId,
      items.map((r) => r.id),
    );
    return {
      items: items.map((r) => toUserDto(r, rolesByUser.get(r.id) ?? [])),
      nextCursor:
        rows.length > opts.limit ? items[items.length - 1].id : null,
    };
  }

  async function getUser(actor: ActorContext, userId: Id): Promise<UserDto> {
    const row = await findUserById(db, actor.companyId, userId);
    if (!row) throw notFound();
    const roles = await loadUserRoleKeys(db, actor.companyId, row.id);
    return toUserDto(row, roles);
  }

  /**
   * POST /users — owner/admin. Always a pending MEMBER: the member role is
   * fixed here (admin can never mint owner/admin; elevated roles come later
   * via owner setRoles), there is no password yet (activation is task 1.4)
   * and no manager assignment (owner grafts the tree separately).
   */
  async function createPendingUser(
    actor: ActorContext,
    input: {
      email: string;
      name: string;
      title?: string;
      departmentId?: string;
      teamId?: string;
    },
  ): Promise<UserDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireOwnerOrAdmin(tx, actor);
      await requireActiveActor(tx, actor);

      const existing = await findUserIdByEmail(
        tx,
        actor.companyId,
        input.email,
      );
      if (existing) {
        throw new AppError(409, "EMAIL_TAKEN", "Email đã được sử dụng");
      }

      const assignment = await resolveOrgAssignment(
        tx,
        actor.companyId,
        { departmentId: input.departmentId, teamId: input.teamId },
        { department_id: null, team_id: null },
      );

      let row: UserRow;
      try {
        row = await insertUser(tx, {
          company_id: actor.companyId,
          email: input.email,
          name: input.name,
          title: input.title ?? null,
          department_id: assignment.department_id,
          team_id: assignment.team_id,
          status: "pending",
        });
      } catch (err) {
        // Race-safe twin of the pre-check: the (company_id,
        // email_normalized) unique index is the real guard.
        if ((err as { code?: string }).code === "23505") {
          throw new AppError(409, "EMAIL_TAKEN", "Email đã được sử dụng");
        }
        throw err;
      }
      const roleIds = await roleIdsByKey(tx);
      const memberRole = roleIds.get("member");
      if (!memberRole) {
        throw new AppError(500, "INTERNAL", "Thiếu role member");
      }
      await replaceUserRoles(tx, actor.companyId, row.id, [memberRole]);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "user.create",
        targetType: "app_user",
        targetId: row.id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { status: "pending", role: "member" },
      });
      return toUserDto(row, ["member"]);
    });
  }

  /**
   * PATCH /users/:id — non-privileged fields only (name, title,
   * department/team). Self-edit covers name/title only — org placement is
   * org config (spec §4), so departmentId/teamId require owner/admin even
   * on the caller's own row, and a non-owner admin may never touch an
   * owner/admin profile — including its own org fields (spec §4
   * no-self-escalation boundary). Role, manager, email and credentials
   * never pass through this route — the strict schema rejects those keys
   * with 400 upstream.
   */
  async function updateProfile(
    actor: ActorContext,
    userId: Id,
    patch: {
      name?: string;
      title?: string | null;
      departmentId?: string | null;
      teamId?: string | null;
    },
  ): Promise<UserDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await requireActiveActor(tx, actor);
      const target = await findUserById(tx, actor.companyId, userId);
      if (!target) throw notFound();

      // Self-edit covers name/title only — org placement is org config
      // (spec §4: members hold zero org-config rights), so a patch carrying
      // departmentId/teamId takes the owner/admin path even on the
      // caller's own row. An admin editing SELF stays a privileged target
      // here, so its own org fields remain owner-only.
      const touchesOrgPlacement =
        patch.departmentId !== undefined || patch.teamId !== undefined;
      if (actor.userId !== userId || touchesOrgPlacement) {
        const { isOwner } = await requireOwnerOrAdmin(tx, actor);
        if (!isOwner) {
          const targetRoles = await loadUserRoleKeys(
            tx,
            actor.companyId,
            userId,
          );
          if (
            targetRoles.includes("owner") ||
            targetRoles.includes("admin")
          ) {
            throw new AppError(
              403,
              "FORBIDDEN",
              "Admin không được chỉnh tài khoản đặc quyền",
            );
          }
        }
      }

      const fields: string[] = [];
      const update: {
        name?: string;
        title?: string | null;
        department_id?: string | null;
        team_id?: string | null;
      } = {};
      if (patch.name !== undefined) {
        update.name = patch.name;
        fields.push("name");
      }
      if (patch.title !== undefined) {
        update.title = patch.title;
        fields.push("title");
      }
      if (
        patch.departmentId !== undefined ||
        patch.teamId !== undefined
      ) {
        const assignment = await resolveOrgAssignment(
          tx,
          actor.companyId,
          { departmentId: patch.departmentId, teamId: patch.teamId },
          target,
        );
        update.department_id = assignment.department_id;
        update.team_id = assignment.team_id;
        if (patch.departmentId !== undefined) fields.push("departmentId");
        if (patch.teamId !== undefined) fields.push("teamId");
      }

      const updated = await updateUser(tx, actor.companyId, userId, update);
      if (!updated) throw notFound();
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "user.update",
        targetType: "app_user",
        targetId: userId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { field: fields.join(",") },
      });
      const roles = await loadUserRoleKeys(tx, actor.companyId, userId);
      return toUserDto(updated, roles);
    });
  }

  /**
   * PUT /users/:id/roles — OWNER ONLY (admin → 403 even on self). `roles`
   * is the full replacement set; unknown keys were rejected 400 by the
   * schema. Stripping owner from the last ACTIVE owner → 409 LAST_OWNER,
   * decided under the company lock so a concurrent winner's commit is
   * already visible.
   */
  async function setRoles(
    actor: ActorContext,
    userId: Id,
    roles: Role[],
  ): Promise<UserDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const actorRoles = await loadActorRoles(
        tx,
        actor.companyId,
        actor.userId,
      );
      if (!actorRoles.includes("owner")) {
        throw new AppError(403, "FORBIDDEN", "Chỉ owner được đổi quyền");
      }
      await requireActiveActor(tx, actor);

      const target = await findUserById(tx, actor.companyId, userId);
      if (!target) throw notFound();
      const targetRoles = await loadUserRoleKeys(
        tx,
        actor.companyId,
        userId,
      );
      const next = [...new Set(roles)];

      // Last-owner protection: removing the owner role from an ACTIVE
      // owner must leave at least one other active owner behind.
      if (
        target.status === "active" &&
        targetRoles.includes("owner") &&
        !next.includes("owner")
      ) {
        await assertNotLastOwner(tx, actor.companyId);
      }

      const roleIds = await roleIdsByKey(tx);
      await replaceUserRoles(
        tx,
        actor.companyId,
        userId,
        next.map((key) => {
          const id = roleIds.get(key);
          if (!id) {
            throw new AppError(500, "INTERNAL", `Thiếu role ${key}`);
          }
          return id;
        }),
      );
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "user.set_roles",
        targetType: "app_user",
        targetId: userId,
        outcome: "success",
        requestId: actor.requestId,
        // Scalar allowlist only — record the resulting set joined, never
        // the raw array (which sanitizeAuditMetadata would strip anyway).
        metadata: { field: "roles", role: next.slice().sort().join(",") },
      });
      return toUserDto(target, next);
    });
  }

  /**
   * POST /users/:id/deactivate — owner/admin (spec §4 asymmetry):
   * - admin may deactivate plain members only — never an owner/admin
   *   account (that gate precedes the idempotent no-op: re-deactivating an
   *   already-inactive privileged user is still 403), and never a user
   *   who still has direct reports AT ALL (moving a reporting line is
   *   owner territory; admin must not reshape the tree indirectly,
   *   spec §3);
   * - owner may deactivate anyone except the last ACTIVE owner;
   * - a target with ANY direct reports — active or dormant — requires the
   *   owner's explicit decision: replacementManagerId uuid transfers every
   *   direct report, explicit null unassigns them — inside the SAME
   *   transaction as the status flip; a missing key → 403
   *   REPORTS_UNASSIGNED. A dormant edge may not be stranded on the
   *   inactive manager (§3's manager_id rules are not status-qualified),
   *   and the replacement is fully validated either way (same company,
   *   active, never the target itself, never inside its subtree).
   * The commit is followed by revokeAllUserSessions (durable kill; the
   * status check alone only denies, it does not write). Re-deactivating an
   * already-inactive user is an idempotent no-op — we still run the
   * session sweep so a previously orphaned session cannot survive.
   */
  async function deactivateUser(
    actor: ActorContext,
    userId: Id,
    input: { replacementManagerId?: string | null },
  ): Promise<UserDto> {
    const { user, roles } = await db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const { isOwner } = await requireOwnerOrAdmin(tx, actor);
      await requireActiveActor(tx, actor);

      const target = await findUserById(tx, actor.companyId, userId);
      if (!target) throw notFound();
      const targetRoles = await loadUserRoleKeys(
        tx,
        actor.companyId,
        userId,
      );

      // Privileged targets first — admin may never deactivate an
      // owner/admin account, and that gate must precede the idempotent
      // early-return so re-deactivating an already-inactive privileged
      // user still 403s instead of reading as a no-op.
      if (
        !isOwner &&
        (targetRoles.includes("owner") || targetRoles.includes("admin"))
      ) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Admin không được deactivate tài khoản đặc quyền",
        );
      }

      // Idempotent no-op: already inactive stays inactive (200 as-is).
      if (target.status === "inactive") {
        return { user: target, roles: targetRoles, reportsMoved: 0 };
      }

      const reports = await listDirectReports(tx, actor.companyId, userId);
      let reportsMoved = 0;
      if (reports.length > 0) {
        // ANY direct report — active or dormant — makes this a tree
        // reshape (spec §3 "có cấp dưới" and "manager_id không trỏ tài
        // khoản inactive" are not status-qualified): admin may not move
        // manager_id edges even indirectly, and a dormant edge may not be
        // stranded pointing at the deactivated manager.
        if (!isOwner) {
          throw new AppError(
            403,
            "FORBIDDEN",
            "Admin không được deactivate tài khoản còn cấp dưới",
          );
        }
        if (input.replacementManagerId === undefined) {
          // Brief's literal status: manager inactive cần chuyển cấp
          // dưới → trả 403 (not 409).
          throw new AppError(
            403,
            "REPORTS_UNASSIGNED",
            "Người dùng còn cấp dưới — cần replacementManagerId hoặc null",
          );
        }
        if (input.replacementManagerId !== null) {
          const replacementId = input.replacementManagerId;
          if (replacementId === userId) {
            throw new AppError(
              400,
              "INVALID_INPUT",
              "Cấp trên thay thế không thể là chính người bị deactivate",
              { fields: ["replacementManagerId"] },
            );
          }
          const replacement = await findUserById(
            tx,
            actor.companyId,
            replacementId,
          );
          if (!replacement) throw notFound();
          if (replacement.status !== "active") {
            throw new AppError(
              409,
              "USER_NOT_ACTIVE",
              "Cấp trên thay thế không ở trạng thái hoạt động",
            );
          }
          // A replacement inside the target's subtree would close a
          // reporting cycle through the moved edges — the subtree walk
          // is status-agnostic, so a descendant hidden under a dormant
          // edge still counts.
          const descendants = await listSubtreeUserIds(
            tx,
            actor.companyId,
            userId,
          );
          if (descendants.includes(replacementId)) {
            throw new AppError(
              409,
              "REPORTING_CYCLE",
              "Không thể tạo vòng trong tuyến báo cáo",
            );
          }
        }
        // Transfer EVERY direct report (active or not) so no edge is
        // left pointing at an inactive account.
        reportsMoved = await transferDirectReports(
          tx,
          actor.companyId,
          userId,
          input.replacementManagerId,
        );
      }

      // Last-owner protection: deactivating an ACTIVE owner must leave at
      // least one other active owner behind.
      if (target.status === "active" && targetRoles.includes("owner")) {
        await assertNotLastOwner(tx, actor.companyId);
      }

      const updated = await updateUser(tx, actor.companyId, userId, {
        status: "inactive",
      });
      if (!updated) throw notFound();
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "user.deactivate",
        targetType: "app_user",
        targetId: userId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { status: "inactive", count: reportsMoved },
      });
      return { user: updated, roles: targetRoles, reportsMoved };
    });

    // Standalone-tx signature (phase-0 contract): revoke right AFTER the
    // mutation commits. Ordering rationale: the inactive status is already
    // durable and authenticate() denies on it immediately, so the revoke
    // only needs to be the durable write — never inside the company-lock
    // tx where its second connection would commit independently.
    await revokeAllUserSessions(userId, actor.requestId, "deactivate");
    return toUserDto(user, roles);
  }

  /**
   * POST /users/:id/reactivate — owner/admin, the inverse of deactivate:
   * - same asymmetry: admin may reactivate plain members only, never an
   *   owner/admin account (restoring a privileged login is owner
   *   territory, spec §4);
   * - only an INACTIVE account can be reactivated — active/pending targets
   *   are 409 USER_NOT_INACTIVE (not a silent no-op: the caller's view is
   *   stale and should refresh);
   * - resulting status: deactivation keeps the password hash and durably
   *   revokes every session, so an account that holds a password returns
   *   to ACTIVE with that credential — its old sessions stay revoked (a
   *   fresh login is required), and the owner can issue a reset code
   *   straight away if the credential is no longer trusted. An account
   *   that never set a password (deactivated while pending) returns to
   *   PENDING — the active_password CHECK forbids active-without-hash —
   *   and the owner issues an activation code as for a new user. Neither
   *   path lets the caller set or read a credential (spec §4/§8);
   * - roles, manager, department and team are kept: the account's reports
   *   were moved off it at deactivation and setManager never points
   *   anyone at a non-active user, so the tree invariants still hold.
   */
  async function reactivateUser(
    actor: ActorContext,
    userId: Id,
  ): Promise<UserDto> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const { isOwner } = await requireOwnerOrAdmin(tx, actor);
      await requireActiveActor(tx, actor);

      const target = await findUserById(tx, actor.companyId, userId);
      if (!target) throw notFound();
      const targetRoles = await loadUserRoleKeys(
        tx,
        actor.companyId,
        userId,
      );
      if (
        !isOwner &&
        (targetRoles.includes("owner") || targetRoles.includes("admin"))
      ) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Admin không được kích hoạt lại tài khoản đặc quyền",
        );
      }
      if (target.status !== "inactive") {
        throw new AppError(
          409,
          "USER_NOT_INACTIVE",
          "Chỉ tài khoản đã ngừng hoạt động mới kích hoạt lại được",
        );
      }

      const nextStatus = (await userHasPassword(tx, actor.companyId, userId))
        ? "active"
        : "pending";
      const updated = await updateUser(tx, actor.companyId, userId, {
        status: nextStatus,
      });
      if (!updated) throw notFound();
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "user.reactivate",
        targetType: "app_user",
        targetId: userId,
        outcome: "success",
        requestId: actor.requestId,
        metadata: { status: nextStatus },
      });
      return toUserDto(updated, targetRoles);
    });
  }

  return {
    listUsers: listUserPage,
    getUser,
    createPendingUser,
    updateProfile,
    setRoles,
    deactivateUser,
    reactivateUser,
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
