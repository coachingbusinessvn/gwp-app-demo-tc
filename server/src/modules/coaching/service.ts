import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { ActorContext, Clock, Id, Page } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import type { KeysetCursor } from "../../shared/pagination.js";
import { appendAudit } from "../audit/service.js";
import {
  assertActiveActor,
  findCompanyUser,
  listSubtreeUserIds,
  loadActorRoles,
} from "../authorization/repository.js";
import type { SubjectPolicy } from "../authorization/policy.js";
import {
  actorIsOwner,
  applyReportReadScope,
  assertReportRead as assertReportReadOn,
} from "./policy.js";
import type { CreateSessionBody } from "./schema.js";

/**
 * Coaching service (task 4.1, spec §6): session recording and the report
 * read path. Two rules dominate:
 *
 * - A session's coach is the LOGGED-IN actor and must currently manage the
 *   coachee (or be the owner). An owner may also enter a session on another
 *   coach's behalf — the override is audited as its own action, and the
 *   creator flag never grants share rights (spec §6).
 * - Report access is decided ONLY by the report ACL (creator / session
 *   coach / owner / active share) — never by the reporting tree and never
 *   by canvas access. Every successful detail read is audited with
 *   metadata only; report bodies never enter audit or logs.
 */

function notFound(): AppError {
  return new AppError(404, "NOT_FOUND", "Không tìm thấy tài nguyên");
}

interface ReportRow {
  id: string;
  session_id: string;
  ai_run_id: string | null;
  report_version: number;
  rubric_version: string | null;
  body: unknown;
  provenance: unknown;
  created_by: string;
  created_at: Date | string;
  coach_user_id: string;
  coachee_user_id: string;
  canvas_id: string | null;
  occurred_at: Date | string;
}

export interface ReportDto {
  id: string;
  sessionId: string;
  coachUserId: string;
  coacheeUserId: string;
  canvasId: string | null;
  occurredAt: string;
  reportVersion: number;
  rubricVersion: string | null;
  aiRunId: string | null;
  body: unknown;
  provenance: unknown;
  createdBy: string;
  createdAt: string;
}

export interface ReportListItemDto {
  id: string;
  sessionId: string;
  coachUserId: string;
  coacheeUserId: string;
  canvasId: string | null;
  reportVersion: number;
  rubricVersion: string | null;
  createdBy: string;
  createdAt: string;
}

function toReportDto(row: ReportRow): ReportDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    coachUserId: row.coach_user_id,
    coacheeUserId: row.coachee_user_id,
    canvasId: row.canvas_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    reportVersion: row.report_version,
    rubricVersion: row.rubric_version,
    aiRunId: row.ai_run_id,
    body: row.body,
    provenance: row.provenance,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function toListItem(row: ReportRow): ReportListItemDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    coachUserId: row.coach_user_id,
    coacheeUserId: row.coachee_user_id,
    canvasId: row.canvas_id,
    reportVersion: row.report_version,
    rubricVersion: row.rubric_version,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const REPORT_COLUMNS = [
  "r.id",
  "r.session_id",
  "r.ai_run_id",
  "r.report_version",
  "r.rubric_version",
  "r.body",
  "r.provenance",
  "r.created_by",
  "r.created_at",
  "s.coach_user_id",
  "s.coachee_user_id",
  "s.canvas_id",
  "s.occurred_at",
] as const;

function joinSession(qb: Knex | Knex.Transaction) {
  return qb("coaching_report as r").join(
    "coaching_session as s",
    function () {
      this.on("s.id", "r.session_id").andOn("s.company_id", "r.company_id");
    },
  );
}

export interface CoachingDeps {
  db: Knex;
  policy: SubjectPolicy;
  clock: Clock;
}

export function createCoachingService({ db, policy, clock }: CoachingDeps) {
  /**
   * Record a coaching session. The declared coach is the actor — a forged
   * coachUserId is impersonation and only an owner may do it (historical
   * entry on someone's behalf, audited as coaching.session.create_on_behalf).
   * For the normal path the coach must hold the manager role AND have the
   * coachee inside the CURRENT subtree — a stale relation grants nothing.
   * A linked canvas must be one the actor can read (subject policy on the
   * canvas owner, checked independently of report rights — spec §6).
   */
  async function createSession(
    actor: ActorContext,
    input: CreateSessionBody,
  ): Promise<{ id: string }> {
    const occurredAt = new Date(input.occurredAt);
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt > clock()) {
      throw new AppError(400, "INVALID_INPUT", "occurredAt không hợp lệ", {
        fields: ["occurredAt"],
      });
    }

    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      await assertActiveActor(tx, actor.companyId, actor.userId);

      const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
      const isOwner = roles.includes("owner");
      const onBehalf = input.coachUserId !== actor.userId;
      if (onBehalf && !isOwner) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ owner được nhập phiên coaching thay người khác",
        );
      }

      const coachee = await findCompanyUser(
        tx,
        actor.companyId,
        input.coacheeUserId,
      );
      if (!coachee) throw notFound();
      if (coachee.status !== "active") {
        throw new AppError(
          409,
          "USER_NOT_ACTIVE",
          "Người được coaching không còn hoạt động",
        );
      }

      if (onBehalf) {
        // Historical entry: the named coach must be a real company user;
        // the CURRENT manager relation is not required (the tree may have
        // changed since the session happened).
        const coach = await findCompanyUser(
          tx,
          actor.companyId,
          input.coachUserId,
        );
        if (!coach) throw notFound();
      } else if (!isOwner) {
        if (!roles.includes("manager")) throw notFound();
        const subtree = await listSubtreeUserIds(
          tx,
          actor.companyId,
          actor.userId,
        );
        if (!subtree.includes(input.coacheeUserId)) throw notFound();
      }

      if (input.canvasId !== undefined) {
        const canvasRow = (await tx("canvas")
          .where({ id: input.canvasId, company_id: actor.companyId })
          .select("owner_user_id")
          .first()) as { owner_user_id: string } | undefined;
        if (!canvasRow) throw notFound();
        await policy.assertSubjectAccess(actor, canvasRow.owner_user_id, tx);
      }

      const id = randomUUID();
      await tx("coaching_session").insert({
        id,
        company_id: actor.companyId,
        coach_user_id: input.coachUserId,
        coachee_user_id: input.coacheeUserId,
        canvas_id: input.canvasId ?? null,
        occurred_at: occurredAt,
        created_by: actor.userId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: onBehalf
          ? "coaching.session.create_on_behalf"
          : "coaching.session.create",
        targetType: "coaching_session",
        targetId: id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: {},
      });
      return { id };
    });
  }

  /**
   * The public read gate for other modules (task 4.3's share/delete and the
   * renderer bridge): caller may pass its transaction so the check serializes
   * with the caller's write; standalone calls read on the base connection.
   */
  async function assertReportRead(
    actor: ActorContext,
    reportId: Id,
    tx?: Knex.Transaction,
  ): Promise<void> {
    await assertReportReadOn(tx ?? db, actor, reportId);
  }

  /**
   * One report for an authorized reader. The ACL predicate is part of the
   * row fetch (no check-then-read gap), and the audit row is written in the
   * same transaction BEFORE the response leaves — metadata only, never the
   * report body (spec §9).
   */
  async function getReport(
    actor: ActorContext,
    reportId: Id,
  ): Promise<ReportDto> {
    return db.transaction(async (tx) => {
      await assertActiveActor(tx, actor.companyId, actor.userId);
      const isOwner = await actorIsOwner(tx, actor);
      const row = (await applyReportReadScope(
        tx,
        joinSession(tx)
          .where({ "r.id": reportId, "r.company_id": actor.companyId })
          .select([...REPORT_COLUMNS]),
        actor,
        isOwner,
      ).first()) as ReportRow | undefined;
      if (!row) throw notFound();
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "coaching.report.read",
        targetType: "coaching_report",
        targetId: row.id,
        outcome: "success",
        requestId: actor.requestId,
        metadata: {},
      });
      return toReportDto(row);
    });
  }

  /**
   * Newest-first keyset page over the SAME ACL — the list never widens or
   * narrows differently from detail (spec §2's "same filter set" rule).
   * coacheeUserId filters inside the visible scope; it can only hide rows,
   * never reveal them.
   */
  async function listReports(
    actor: ActorContext,
    opts: { limit: number; cursor?: KeysetCursor; coacheeUserId?: Id },
  ): Promise<Page<ReportListItemDto>> {
    return db.transaction(async (tx) => {
      await assertActiveActor(tx, actor.companyId, actor.userId);
      const isOwner = await actorIsOwner(tx, actor);
      let q = joinSession(tx)
        .where("r.company_id", actor.companyId)
        .orderBy([
          { column: "r.created_at", order: "desc" },
          { column: "r.id", order: "desc" },
        ])
        .limit(opts.limit + 1)
        .select([
          ...REPORT_COLUMNS,
          // µs-precision cursor component — JS Date truncates to ms.
          tx.raw(
            `to_char(r.created_at AT TIME ZONE 'UTC', ` +
              `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`,
          ),
        ]);
      q = applyReportReadScope(tx, q, actor, isOwner);
      if (opts.coacheeUserId !== undefined) {
        q = q.andWhere("s.coachee_user_id", opts.coacheeUserId);
      }
      if (opts.cursor !== undefined) {
        q = q.whereRaw("(r.created_at, r.id) < (?::timestamptz, ?::uuid)", [
          opts.cursor.at,
          opts.cursor.id,
        ]);
      }
      const rows = (await q) as (ReportRow & { cursor_ts: string })[];
      const items = rows.slice(0, opts.limit);
      return {
        items: items.map(toListItem),
        nextCursor:
          rows.length > opts.limit
            ? `${items[items.length - 1].cursor_ts}|${items[items.length - 1].id}`
            : null,
      };
    });
  }

  return { createSession, assertReportRead, getReport, listReports };
}

export type CoachingService = ReturnType<typeof createCoachingService>;
