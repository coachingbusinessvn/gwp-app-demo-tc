import type { Knex } from "knex";
import type { ActorContext, Id } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { loadActorRoles } from "../authorization/repository.js";

/**
 * Report-read ACL (task 4.1, spec §6) — deliberately INDEPENDENT of the
 * canvas subject policy: a coaching report evaluates the coach, so access
 * never flows from the reporting tree or from canvas ownership.
 *
 * Read = owner role (fresh DB read, never JWT) OR report creator OR the
 * session's coach OR an active report_share row. Everyone else — including
 * the coachee, admin, and a manager who gained the reporting line after
 * the session — gets the same 404 as a nonexistent id. Denied reads are
 * not audited: nothing was read.
 *
 * Queries over coaching_report must join coaching_session as `s` and alias
 * the report as `r` before applying applyReportReadScope.
 */
type Qb = Knex | Knex.Transaction;

export interface ReportAclRow {
  id: string;
  session_id: string;
  created_by: string;
  coach_user_id: string;
}

function notFound(): AppError {
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

/** Fresh owner check — roles are re-read per call, never cached. */
export async function actorIsOwner(
  qb: Qb,
  actor: ActorContext,
): Promise<boolean> {
  const roles = await loadActorRoles(qb, actor.companyId, actor.userId);
  return roles.includes("owner");
}

/**
 * The plan's read-gate contract, shared by detail and list:
 *
 *   WHERE ( :isOwner
 *           OR r.created_by = :actor
 *           OR s.coach_user_id = :actor
 *           OR EXISTS (SELECT 1 FROM report_share sh
 *                      WHERE sh.report_id = r.id
 *                        AND sh.user_id = :actor
 *                        AND sh.revoked_at IS NULL) )
 *
 * Owner gets the whole company — the OR group is skipped entirely so the
 * query stays sargable on (company_id, created_at).
 */
export function applyReportReadScope(
  qb: Qb,
  q: Knex.QueryBuilder,
  actor: ActorContext,
  isOwner: boolean,
): Knex.QueryBuilder {
  if (isOwner) return q;
  return q.andWhere(function () {
    this.where("r.created_by", actor.userId)
      .orWhere("s.coach_user_id", actor.userId)
      .orWhereExists(
        qb("report_share")
          .select(qb.raw("1"))
          .whereRaw("report_share.report_id = r.id")
          .andWhere("report_share.user_id", actor.userId)
          .whereNull("report_share.revoked_at"),
      );
  });
}

/**
 * Load one report the actor may read — row id, session id, creator and the
 * session's coach are everything the ACL decision needs. Full detail is
 * fetched by the service once the gate passes.
 */
export async function findReadableReport(
  qb: Qb,
  actor: ActorContext,
  reportId: Id,
): Promise<ReportAclRow | undefined> {
  const isOwner = await actorIsOwner(qb, actor);
  const q = qb("coaching_report as r")
    .join("coaching_session as s", function () {
      this.on("s.id", "r.session_id").andOn("s.company_id", "r.company_id");
    })
    .where({ "r.id": reportId, "r.company_id": actor.companyId })
    .select("r.id", "r.session_id", "r.created_by", "s.coach_user_id");
  return (await applyReportReadScope(qb, q, actor, isOwner).first()) as
    | ReportAclRow
    | undefined;
}

/** Same denial for missing, foreign and unreadable reports — 404. */
export async function assertReportRead(
  qb: Qb,
  actor: ActorContext,
  reportId: Id,
): Promise<ReportAclRow> {
  const row = await findReadableReport(qb, actor, reportId);
  if (!row) throw notFound();
  return row;
}
