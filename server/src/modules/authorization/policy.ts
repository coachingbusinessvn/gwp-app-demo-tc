import type { Knex } from "knex";
import type { ActorContext, Id } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import {
  findCompanyUser,
  listCompanyUserIds,
  listSubtreeUserIds,
  loadActorRoles,
} from "./repository.js";

/**
 * Subject-access policy (task 1.2, spec §4) — the shared boundary every
 * per-subject read/write must go through (canvas in Phase 2, coaching
 * reports in Phase 4, any future MCP wrapper).
 *
 * Access = self OR owner (whole company) OR the actor holds the manager
 * role AND the subject sits in the actor's CURRENT reporting subtree.
 * Roles and the tree are re-read from the database on every call — never
 * cached on the ActorContext, never trusted from the JWT — so a manager
 * change or a revoked role takes effect on the very next request.
 *
 * Admin deliberately gets no subtree privilege: admin manages org metadata,
 * not user content. A tree parent without the manager role gains nothing —
 * being above someone in the tree is not itself a permission.
 *
 * Defense in depth: an inactive actor can reach nothing even though
 * authenticate() already rejects it, and a subject id that is malformed,
 * unknown or outside the actor's company is a uniform denial — assert
 * reports it as 404 so existence is never enumerable.
 */
type Qb = Knex | Knex.Transaction;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(): AppError {
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

export function createPolicy(db: Knex) {
  async function actorIsActive(qb: Qb, actor: ActorContext): Promise<boolean> {
    const me = await findCompanyUser(qb, actor.companyId, actor.userId);
    return me !== undefined && me.status === "active";
  }

  async function canAccessSubject(
    actor: ActorContext,
    subjectUserId: Id,
    tx?: Knex.Transaction,
  ): Promise<boolean> {
    const qb = tx ?? db;
    if (!(await actorIsActive(qb, actor))) return false;
    if (subjectUserId === actor.userId) return true;
    // A malformed id can never resolve to a company user — deny before the
    // uuid cast can turn it into a 500.
    if (!UUID_RE.test(subjectUserId)) return false;

    const roles = await loadActorRoles(qb, actor.companyId, actor.userId);
    if (roles.includes("owner")) {
      const subject = await findCompanyUser(
        qb,
        actor.companyId,
        subjectUserId,
      );
      return subject !== undefined;
    }
    if (roles.includes("manager")) {
      const subtree = await listSubtreeUserIds(
        qb,
        actor.companyId,
        actor.userId,
      );
      return subtree.includes(subjectUserId);
    }
    return false;
  }

  /** Same denial for missing, foreign and unauthorized subjects — 404. */
  async function assertSubjectAccess(
    actor: ActorContext,
    subjectUserId: Id,
    tx?: Knex.Transaction,
  ): Promise<void> {
    if (!(await canAccessSubject(actor, subjectUserId, tx))) {
      throw notFound();
    }
  }

  /**
   * The subject ids this actor may see — for list/count/dashboard filters.
   * An inactive actor scopes to nothing; a role-less actor scopes to self.
   */
  async function scopeSubjectIds(
    actor: ActorContext,
    tx?: Knex.Transaction,
  ): Promise<string[]> {
    const qb = tx ?? db;
    if (!(await actorIsActive(qb, actor))) return [];

    const roles = await loadActorRoles(qb, actor.companyId, actor.userId);
    if (roles.includes("owner")) {
      return listCompanyUserIds(qb, actor.companyId);
    }
    if (roles.includes("manager")) {
      // The walk anchors on the actor's own row, so self is included.
      return listSubtreeUserIds(qb, actor.companyId, actor.userId);
    }
    return [actor.userId];
  }

  return { canAccessSubject, assertSubjectAccess, scopeSubjectIds };
}

export type SubjectPolicy = ReturnType<typeof createPolicy>;
