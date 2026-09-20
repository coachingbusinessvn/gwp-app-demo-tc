import type { Knex } from "knex";
import type { ActorContext, Id } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { appendAudit } from "../audit/service.js";
import {
  assertActiveActor,
  findCompanyUser,
  listSubtreeUserIds,
  loadActorRoles,
  updateManagerId,
} from "../authorization/repository.js";

/**
 * Reporting-tree mutation (task 1.2, spec §3/§4).
 *
 * setManager is OWNER ONLY — the reporting tree is a privilege boundary, so
 * admin must not be able to graft itself into it (the §4 "no
 * self-escalation" rule). Every write serializes on lockCompany: the loser
 * of a concurrent pair re-reads the winner's committed tree inside the same
 * transaction, so two edits that would together form a cycle produce
 * exactly one success and one clean 409 — never a 500.
 *
 * A change takes effect on the next authorization read because nothing is
 * cached (the policy walks app_user.manager_id fresh each call): the old
 * manager loses subtree access immediately, the new one gains it only if it
 * actually holds the manager role.
 */
export interface UserManagerDto {
  id: Id;
  managerId: Id | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): AppError {
  // Consistent 404 for missing/foreign/malformed ids (spec §2/§4).
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

export function createReportingService({ db }: { db: Knex }) {
  async function setManager(
    actor: ActorContext,
    userId: Id,
    managerId: Id | null,
  ): Promise<UserManagerDto> {
    return db.transaction(async (tx) => {
      // Serialize all tree mutations per company first, then decide on the
      // state read AFTER the lock — a concurrent winner is already visible.
      await lockCompany(tx, actor.companyId);

      const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
      if (!roles.includes("owner")) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ owner được thay đổi tuyến báo cáo",
        );
      }
      // Defense in depth: authenticate() already rejects inactive users;
      // re-check here so a stale context can never mutate the tree.
      await assertActiveActor(tx, actor.companyId, actor.userId);

      if (!UUID_RE.test(userId)) throw notFound();
      const subject = await findCompanyUser(tx, actor.companyId, userId);
      if (!subject) throw notFound();
      if (subject.status !== "active") {
        throw new AppError(
          409,
          "USER_NOT_ACTIVE",
          "Người dùng không ở trạng thái hoạt động",
        );
      }

      if (managerId !== null) {
        // Self-assignment is statically invalid — a length-1 cycle the DB
        // CHECK (manager_not_self) also forbids; reject before the write.
        if (managerId === userId) {
          throw new AppError(
            400,
            "INVALID_INPUT",
            "Không thể tự làm cấp trên của chính mình",
            { fields: ["managerId"] },
          );
        }
        if (!UUID_RE.test(managerId)) throw notFound();
        const manager = await findCompanyUser(tx, actor.companyId, managerId);
        if (!manager) throw notFound();
        if (manager.status !== "active") {
          throw new AppError(
            409,
            "USER_NOT_ACTIVE",
            "Cấp trên không ở trạng thái hoạt động",
          );
        }
        // The new manager must not already sit in the subject's subtree —
        // that edge would close a reporting cycle.
        const descendants = await listSubtreeUserIds(
          tx,
          actor.companyId,
          userId,
        );
        if (descendants.includes(managerId)) {
          throw new AppError(
            409,
            "REPORTING_CYCLE",
            "Không thể tạo vòng trong tuyến báo cáo",
          );
        }
      }

      const updated = await updateManagerId(tx, actor.companyId, userId, managerId);
      if (!updated) throw notFound();
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "org.user.set_manager",
        targetType: "app_user",
        targetId: userId,
        outcome: "success",
        requestId: actor.requestId,
        // The allowlist strips values, so record WHICH field moved only —
        // the target id is already on the event row.
        metadata: { field: "manager_id" },
      });
      return { id: updated.id, managerId: updated.manager_id };
    });
  }

  return { setManager };
}

export type ReportingService = ReturnType<typeof createReportingService>;
