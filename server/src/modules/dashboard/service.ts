import type { Knex } from "knex";
import type { ActorContext, Clock, Id } from "../../shared/contracts.js";
import type { SubjectPolicy } from "../authorization/policy.js";
import type { CanvasBody } from "../../../../shared/canvas/schema.js";
import { buildSeries, type Series } from "../../../../shared/canvas/measurement.js";

/**
 * Dashboard read model (task 2.6, spec §5.3).
 *
 * Everything derives from each canvas's LATEST PUBLISHED version —
 * drafts are never evidence. Scope comes from the shared subject policy
 * (self / owner-company / manager-subtree, re-resolved per call): the
 * `people` and `canvases` lists contain exactly the subjects the actor
 * may read, and `attention` contains only actions assigned TO the actor
 * on canvases inside that scope — an assignment on an unreadable canvas
 * never reaches the assignee's dashboard (assignee ids are content, not
 * grants). Archived canvases stay listed as "archived" but are frozen:
 * their open actions stop nagging.
 *
 * "Today" is the company's calendar day in company.timezone (admin-editable,
 * default Asia/Ho_Chi_Minh), not UTC. The clock is injectable.
 */

const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";
const DAY_MS = 86_400_000;
const DONE_STATUS = "Hoàn thành";

export interface DashboardPersonDto {
  userId: Id;
  name: string;
  title: string;
  managerId: Id | null;
  canvasCount: number;
  publishedCount: number;
  /** Overdue open actions assigned to this person on readable canvases. */
  overdueActions: number;
}

export interface AttentionItemDto {
  actionId: string;
  canvasId: Id;
  canvasName: string;
  action: string;
  deadline: string;
  status: string;
  assigneeUserId: Id;
  assigneeLabel: string;
  daysOverdue: number;
}

export interface DashboardCanvasDto {
  id: Id;
  name: string;
  ownerUserId: Id;
  ownerName: string;
  /** unpublished = no published version yet; archived stays listed. */
  status: "unpublished" | "published" | "archived";
  stage: string | null;
  currentVersionNo: number | null;
  publishedAt: string | null;
  openActions: number;
  overdueActions: number;
  series: Series[];
}

export interface DashboardDto {
  generatedAt: string;
  people: DashboardPersonDto[];
  attention: AttentionItemDto[];
  canvases: DashboardCanvasDto[];
}

type Qb = Knex | Knex.Transaction;

interface ScopedUserRow {
  id: string;
  name: string;
  title: string;
  manager_id: string | null;
}

interface DashboardCanvasRow {
  id: string;
  owner_user_id: string;
  owner_name: string;
  name: string;
  status: string;
  current_version_id: string | null;
  version_no: number | null;
  published_at: Date | string | null;
  body: CanvasBody | null;
}

/** Calendar date "YYYY-MM-DD" of an instant in the company timezone. An
 * unknown IANA zone (stale row, runtime without that tzdata) falls back to
 * the default rather than failing the whole dashboard. */
function companyDay(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: DEFAULT_TIME_ZONE,
    }).format(d);
  }
}

/** Whole days between two YYYY-MM-DD strings (UTC parse — pure dates). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

export function createDashboardService(deps: {
  db: Knex;
  policy: SubjectPolicy;
  clock: Clock;
}) {
  const { db, policy, clock } = deps;

  async function listScopedUsers(
    qb: Qb,
    companyId: Id,
    userIds: string[],
  ): Promise<ScopedUserRow[]> {
    if (userIds.length === 0) return [];
    return (await qb("app_user")
      .where({ company_id: companyId })
      .whereIn("id", userIds)
      .select("id", "name", "title", "manager_id")) as ScopedUserRow[];
  }

  /**
   * Every canvas owned by a scoped subject, joined to its current
   * published version (body included — it IS the evidence source).
   * Unpublished canvases left-join to nulls and report "unpublished".
   */
  async function listScopedCanvasRows(
    qb: Qb,
    companyId: Id,
    ownerIds: string[],
  ): Promise<DashboardCanvasRow[]> {
    if (ownerIds.length === 0) return [];
    return (await qb("canvas")
      .join("app_user", function () {
        this.on("app_user.id", "=", "canvas.owner_user_id").andOn(
          "app_user.company_id",
          "=",
          "canvas.company_id",
        );
      })
      .leftJoin("canvas_version", function () {
        this.on("canvas_version.id", "=", "canvas.current_version_id")
          .andOn("canvas_version.company_id", "=", "canvas.company_id")
          .andOn("canvas_version.canvas_id", "=", "canvas.id");
      })
      .where({ "canvas.company_id": companyId })
      .whereIn("canvas.owner_user_id", ownerIds)
      .orderBy("canvas.created_at", "desc")
      .select(
        "canvas.id",
        "canvas.owner_user_id",
        "app_user.name as owner_name",
        "canvas.name",
        "canvas.status",
        "canvas.current_version_id",
        "canvas_version.version_no",
        "canvas_version.published_at",
        "canvas_version.body",
      )) as DashboardCanvasRow[];
  }

  async function getDashboard(actor: ActorContext): Promise<DashboardDto> {
    const subjectIds = await policy.scopeSubjectIds(actor);
    const generatedAt = clock().toISOString();
    const company = (await db("company")
      .where({ id: actor.companyId })
      .first("timezone")) as { timezone: string | null } | undefined;
    const today = companyDay(clock(), company?.timezone || DEFAULT_TIME_ZONE);

    const [users, rows] = await Promise.all([
      listScopedUsers(db, actor.companyId, subjectIds),
      listScopedCanvasRows(db, actor.companyId, subjectIds),
    ]);

    const canvases: DashboardCanvasDto[] = [];
    const attention: AttentionItemDto[] = [];
    // Overdue counts per assignee — for the people rollup.
    const overdueByAssignee = new Map<Id, number>();

    for (const row of rows) {
      const archived = row.status === "archived";
      const published = row.current_version_id !== null && row.body !== null;
      const body = published ? row.body! : null;

      let openActions = 0;
      let overdueActions = 0;
      if (body && !archived) {
        for (const a of body.actions) {
          const open = a.status !== DONE_STATUS;
          const overdue =
            open && a.deadline !== "" && a.deadline < today;
          if (open) openActions += 1;
          if (overdue) {
            overdueActions += 1;
            if (a.assignee_user_id) {
              overdueByAssignee.set(
                a.assignee_user_id,
                (overdueByAssignee.get(a.assignee_user_id) ?? 0) + 1,
              );
            }
            // The actor's own list: only actions assigned to THEM.
            if (a.assignee_user_id === actor.userId) {
              attention.push({
                actionId: a.id,
                canvasId: row.id,
                canvasName: row.name,
                action: a.action,
                deadline: a.deadline,
                status: a.status,
                assigneeUserId: a.assignee_user_id,
                assigneeLabel: a.assignee_label,
                daysOverdue: dayDiff(a.deadline, today),
              });
            }
          }
        }
      }

      canvases.push({
        id: row.id,
        name: row.name,
        ownerUserId: row.owner_user_id,
        ownerName: row.owner_name,
        status: archived ? "archived" : published ? "published" : "unpublished",
        stage: body ? body.meta.stage : null,
        currentVersionNo: row.version_no,
        publishedAt: row.published_at
          ? new Date(row.published_at).toISOString()
          : null,
        openActions,
        overdueActions,
        series: body ? buildSeries(body) : [],
      });
    }

    // Attention: most overdue first, then canvas name for stability.
    attention.sort(
      (a, b) =>
        b.daysOverdue - a.daysOverdue ||
        a.canvasName.localeCompare(b.canvasName),
    );

    const canvasCountByOwner = new Map<Id, { total: number; published: number }>();
    for (const row of rows) {
      const c = canvasCountByOwner.get(row.owner_user_id) ?? {
        total: 0,
        published: 0,
      };
      c.total += 1;
      if (row.current_version_id !== null) c.published += 1;
      canvasCountByOwner.set(row.owner_user_id, c);
    }

    const people: DashboardPersonDto[] = users.map((u) => ({
      userId: u.id,
      name: u.name,
      title: u.title,
      managerId: u.manager_id,
      canvasCount: canvasCountByOwner.get(u.id)?.total ?? 0,
      publishedCount: canvasCountByOwner.get(u.id)?.published ?? 0,
      overdueActions: overdueByAssignee.get(u.id) ?? 0,
    }));

    return { generatedAt, people, attention, canvases };
  }

  return { getDashboard };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
