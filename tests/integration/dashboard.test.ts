import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanvasBody } from "../../shared/canvas/schema.js";
import { buildSeries } from "../../shared/canvas/measurement.js";
import { createDashboardService } from "../../server/src/modules/dashboard/service.js";
import { createPolicy } from "../../server/src/modules/authorization/policy.js";
import { seedDemo } from "../../server/src/db/seed-demo.js";
import { DEMO_IDENTITIES } from "../fixtures/identities.js";
import { loadConfig } from "../../server/src/config.js";
import { fixture, testEnv, type Persona } from "../helpers/fixture.js";

/**
 * Task 2.6 — the real dashboard (spec §5.3).
 *
 *   GET /api/v1/dashboard → { generatedAt, people, attention, canvases }
 *
 * Evidence comes ONLY from each canvas's latest published version — a
 * draft, however complete, is "unpublished" and contributes nothing but
 * its presence. Overdue = action.deadline < today (company timezone,
 * Asia/Ho_Chi_Minh) AND status ≠ "Hoàn thành"; attention lists only
 * actions assigned to the VIEWING actor on canvases they can read — an
 * assignment on an unreadable canvas never leaks into the assignee's
 * dashboard. Series derive from observed[].measurement in the published
 * snapshot only. Assignees are keyed by user id, never by name.
 *
 * Seed tree (tests/helpers/seed-personas.ts):
 *   member → manager → owner,  outsider → owner
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
type TestResponse = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
};

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as CanvasBody;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Day strings in the company timezone so tests are date-agnostic. */
const VN = "Asia/Ho_Chi_Minh";
function dayInVn(offsetDays = 0, from = new Date()): string {
  const d = new Date(from.getTime() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: VN }).format(d);
}
const TODAY = dayInVn(0);
const YESTERDAY = dayInVn(-1);
const TOMORROW = dayInVn(1);

const METRIC_ID = randomUUID();
function measurement(
  over: Record<string, unknown> = {},
): NonNullable<CanvasBody["observed"][number]["measurement"]> {
  return {
    metricId: METRIC_ID,
    definitionRevision: 1,
    layer: "OUTPUT",
    date: YESTERDAY,
    value: 30,
    unit: "%",
    baseline: 20,
    target: 90,
    ...over,
  } as NonNullable<CanvasBody["observed"][number]["measurement"]>;
}

let actionSeq = 0;
function action(over: Record<string, unknown> = {}): CanvasBody["actions"][number] {
  return {
    id: randomUUID(),
    action: `Hành động ${++actionSeq}`,
    start: "",
    deadline: "",
    criteria: "xong",
    status: "Đang thực hiện",
    risk: "",
    assignee_label: "Chuyên viên", // publish requires a non-blank label
    supporter_label: "",
    ...over,
  } as CanvasBody["actions"][number];
}

function dashboard(
  f: Fixture,
  persona: Persona | undefined,
): Promise<TestResponse> {
  return f
    .api(persona)
    .get("/api/v1/dashboard") as unknown as Promise<TestResponse>;
}

async function mustCreate(
  f: Fixture,
  persona: Persona,
  ownerUserId: string,
  name: string,
  body: CanvasBody,
): Promise<string> {
  const res = await f
    .api(persona)
    .post("/api/v1/canvases")
    .send({ ownerUserId, name, body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function mustPublish(
  f: Fixture,
  persona: Persona,
  canvasId: string,
): Promise<TestResponse> {
  const res = await f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/publish`)
    .send({ expectedRevision: 1, idempotencyKey: `pub-${randomUUID()}` });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res as unknown as TestResponse;
}

/** Publishable canvas: canonical body + caller's row overrides. */
function publishable(over: Partial<CanvasBody> = {}): CanvasBody {
  const body = clone(canonical);
  Object.assign(body, over);
  body.meta.title = over.meta?.title ?? "Canvas dashboard";
  return body;
}

describe("GET /api/v1/dashboard", () => {
  it("is Bearer-only — anonymous gets the uniform 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      expect((await dashboard(f, undefined)).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("marks a draft-only canvas unpublished and contributes no evidence", async () => {
    const f = await fixture({ seeded: true });
    try {
      const id = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Draft chưa chốt",
        publishable(),
      );
      const res = await dashboard(f, "member");
      expect(res.status).toBe(200);
      const row = res.body.canvases.find((c: { id: string }) => c.id === id);
      expect(row.status).toBe("unpublished");
      expect(row.currentVersionNo).toBeNull();
      expect(row.series).toEqual([]);
      expect(res.body.attention).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("scopes canvases and people to the actor's subjects", async () => {
    const f = await fixture({ seeded: true });
    try {
      const memberCanvas = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Canvas của member",
        publishable(),
      );
      const outsiderCanvas = await mustCreate(
        f,
        "outsider",
        f.ids.outsider,
        "Canvas của outsider",
        publishable(),
      );

      // member sees only its own canvas — outsider's never leaks.
      const mine = await dashboard(f, "member");
      const memberIds = mine.body.canvases.map((c: { id: string }) => c.id);
      expect(memberIds).toContain(memberCanvas);
      expect(memberIds).not.toContain(outsiderCanvas);
      expect(
        mine.body.people.map((p: { userId: string }) => p.userId),
      ).toEqual([f.ids.member]);

      // manager's subtree includes member — both canvases of member show.
      const mgr = await dashboard(f, "manager");
      const mgrIds = mgr.body.canvases.map((c: { id: string }) => c.id);
      expect(mgrIds).toContain(memberCanvas);
      expect(mgrIds).not.toContain(outsiderCanvas);
      expect(
        mgr.body.people.map((p: { userId: string }) => p.userId).sort(),
      ).toEqual([f.ids.manager, f.ids.member].sort());

      // outsider sits outside manager's subtree — sees only itself.
      const out = await dashboard(f, "outsider");
      const outIds = out.body.canvases.map((c: { id: string }) => c.id);
      expect(outIds).toEqual([outsiderCanvas]);
    } finally {
      await f.close();
    }
  });

  it("attention lists only MY overdue open actions on canvases I can read", async () => {
    const f = await fixture({ seeded: true });
    try {
      const mine = action({
        action: "Việc quá hạn của member",
        deadline: YESTERDAY,
        assignee_label: "Chuyên viên",
        assignee_user_id: f.ids.member,
      });
      const managers = action({
        action: "Việc quá hạn của manager",
        deadline: YESTERDAY,
        assignee_label: "Trưởng phòng",
        assignee_user_id: f.ids.manager,
      });
      const done = action({
        action: "Việc đã xong",
        deadline: YESTERDAY,
        status: "Hoàn thành",
        assignee_user_id: f.ids.member,
      });
      const future = action({
        action: "Việc chưa tới hạn",
        deadline: TOMORROW,
        assignee_user_id: f.ids.member,
      });
      const noDeadline = action({
        action: "Việc không hạn",
        assignee_user_id: f.ids.member,
      });
      const canvasId = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Canvas có việc",
        publishable({ actions: [mine, managers, done, future, noDeadline] }),
      );
      await mustPublish(f, "member", canvasId);

      // member's attention: only its own overdue open action.
      const res = await dashboard(f, "member");
      expect(res.body.attention).toHaveLength(1);
      const item = res.body.attention[0];
      expect(item).toMatchObject({
        actionId: mine.id,
        canvasId,
        assigneeUserId: f.ids.member,
        action: "Việc quá hạn của member",
        deadline: YESTERDAY,
      });
      expect(item.daysOverdue).toBeGreaterThanOrEqual(1);

      // manager reads member's canvas (subtree) — its attention carries
      // the action assigned to MANAGER, not member's.
      const mgr = await dashboard(f, "manager");
      expect(mgr.body.attention).toHaveLength(1);
      expect(mgr.body.attention[0]).toMatchObject({
        actionId: managers.id,
        assigneeUserId: f.ids.manager,
      });

      // outsider can't read the canvas — no attention at all.
      const out = await dashboard(f, "outsider");
      expect(out.body.attention).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("never lets an assignment on an unreadable canvas reach the assignee", async () => {
    const f = await fixture({ seeded: true });
    try {
      // outsider's canvas assigns an overdue action to member — member
      // cannot read outsider's canvas, so it must not see the item.
      const trap = action({
        action: "Việc member không được thấy",
        deadline: YESTERDAY,
        assignee_user_id: f.ids.member,
      });
      const canvasId = await mustCreate(
        f,
        "outsider",
        f.ids.outsider,
        "Canvas kín",
        publishable({ actions: [trap] }),
      );
      await mustPublish(f, "outsider", canvasId);

      const res = await dashboard(f, "member");
      expect(res.body.attention).toEqual([]);
      expect(res.body.canvases.map((c: { id: string }) => c.id)).not.toContain(
        canvasId,
      );
    } finally {
      await f.close();
    }
  });

  it("keys same-label assignees by user id, never by name", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Two different assignees carrying the SAME display label — the
      // dashboard must attribute each by assignee_user_id. Both live on
      // member's canvas: member reads its own, manager reads it via the
      // reporting subtree — each sees only the item assigned to them.
      const members = action({
        action: "Trùm nhãn A",
        deadline: YESTERDAY,
        assignee_label: "Chuyên viên",
        assignee_user_id: f.ids.member,
      });
      const managers = action({
        action: "Trùm nhãn B",
        deadline: YESTERDAY,
        assignee_label: "Chuyên viên",
        assignee_user_id: f.ids.manager,
      });
      const canvasId = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Canvas chung",
        publishable({ actions: [members, managers] }),
      );
      await mustPublish(f, "member", canvasId);

      const memberView = await dashboard(f, "member");
      expect(
        memberView.body.attention.map((x: { actionId: string }) => x.actionId),
      ).toEqual([members.id]);

      const mgrView = await dashboard(f, "manager");
      expect(
        mgrView.body.attention.map((x: { actionId: string }) => x.actionId),
      ).toEqual([managers.id]);

      // The canvas card counts both overdue rows regardless of viewer.
      const row = mgrView.body.canvases.find(
        (c: { id: string }) => c.id === canvasId,
      );
      expect(row.overdueActions).toBe(2);
    } finally {
      await f.close();
    }
  });

  it("derives series from the published snapshot only — draft edits stay invisible", async () => {
    const f = await fixture({ seeded: true });
    try {
      const body = publishable();
      body.observed = [
        {
          id: randomUUID(),
          date: YESTERDAY,
          layer: "OUTPUT",
          value: "65% → 70%",
          source: "QA",
          confidence: "HIGH",
          learning: "",
          decision: "CONTINUE",
          verifier: "",
          measurement: measurement({ value: 30 }),
        },
        {
          id: randomUUID(),
          date: TODAY,
          layer: "OUTPUT",
          value: "bằng chứng tuần này",
          source: "QA",
          confidence: "HIGH",
          learning: "",
          decision: "CONTINUE",
          verifier: "",
          measurement: measurement({ value: 40 }),
        },
      ];
      const canvasId = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Canvas có đo lường",
        body,
      );
      await mustPublish(f, "member", canvasId);

      const res = await dashboard(f, "member");
      const row = res.body.canvases.find(
        (c: { id: string }) => c.id === canvasId,
      );
      expect(row.status).toBe("published");
      expect(row.currentVersionNo).toBe(1);
      expect(row.series).toHaveLength(1);
      expect(row.series[0].points.map((p: { value: number }) => p.value)).toEqual([
        30, 40,
      ]);
      expect(row.series[0].latest).toBe(40);

      // Now draft-edit: a third point exists only in the draft.
      const draft = await f.api("member").get(`/api/v1/canvases/${canvasId}`);
      expect(draft.body.draft).toBeNull(); // publish consumed it
      const reopen = await f
        .api("member")
        .post(`/api/v1/canvases/${canvasId}/draft`);
      expect(reopen.status).toBe(201);
      const rev = reopen.body.revision;
      const baseVersionId = reopen.body.baseVersionId;
      const edited = clone(body);
      edited.observed.push({
        id: randomUUID(),
        date: TODAY,
        layer: "OUTPUT",
        value: "điểm chỉ có trong draft",
        source: "",
        confidence: "HIGH",
        learning: "",
        decision: "CONTINUE",
        verifier: "",
        measurement: measurement({ value: 99 }),
      } as never);
      const save = await f
        .api("member")
        .put(`/api/v1/canvases/${canvasId}/draft`)
        .send({ expectedRevision: rev, baseVersionId, body: edited });
      expect(save.status).toBe(200);

      const after = await dashboard(f, "member");
      const same = after.body.canvases.find(
        (c: { id: string }) => c.id === canvasId,
      );
      expect(same.series[0].points.map((p: { value: number }) => p.value)).toEqual(
        [30, 40],
      );
    } finally {
      await f.close();
    }
  });

  it("shows no fabricated trend for text-only evidence", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Canvas chữ",
        publishable(), // canonical observed rows are text-only
      );
      await mustPublish(f, "member", canvasId);
      const res = await dashboard(f, "member");
      const row = res.body.canvases.find(
        (c: { id: string }) => c.id === canvasId,
      );
      expect(row.series).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("archived canvases report archived status and drop out of attention", async () => {
    const f = await fixture({ seeded: true });
    try {
      const overdue = action({
        deadline: YESTERDAY,
        assignee_user_id: f.ids.member,
      });
      const canvasId = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Canvas archive",
        publishable({ actions: [overdue] }),
      );
      await mustPublish(f, "member", canvasId);
      const arc = await f
        .api("member")
        .post(`/api/v1/canvases/${canvasId}/archive`)
        .send({});
      expect(arc.status).toBe(200);

      const res = await dashboard(f, "member");
      const row = res.body.canvases.find(
        (c: { id: string }) => c.id === canvasId,
      );
      expect(row.status).toBe("archived");
      expect(res.body.attention).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("applies the company timezone day boundary — deadline = today is not overdue", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Stub clock: 2026-08-20T17:30Z = 2026-08-21 00:30 in Asia/Ho_Chi_Minh.
      // "Today" for the company is the 21st while UTC still reads the 20th —
      // a deadline on the 20th must already count as overdue.
      const clock = () => new Date("2026-08-20T17:30:00.000Z");
      const svc = createDashboardService({
        db: f.db,
        policy: createPolicy(f.db),
        clock,
      });

      const dueYesterday = action({
        action: "Hạn 20/08",
        deadline: "2026-08-20",
        assignee_user_id: f.ids.member,
      });
      const dueToday = action({
        action: "Hạn 21/08",
        deadline: "2026-08-21",
        assignee_user_id: f.ids.member,
      });
      const canvasId = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Canvas múi giờ",
        publishable({ actions: [dueYesterday, dueToday] }),
      );
      await mustPublish(f, "member", canvasId);

      const dto = await svc.getDashboard(f.actor("member"));
      expect(dto.attention.map((x: { actionId: string }) => x.actionId)).toEqual(
        [dueYesterday.id],
      );
    } finally {
      await f.close();
    }
  });
});

describe("seedDemo canvases (task 2.6)", () => {
  it("imports only full legacy snapshots as versions; briefs become migration notes", async () => {
    const f = await fixture({ seeded: false });
    try {
      const res = await f.api().post("/api/v1/setup").send({
        bootstrapToken: loadConfig(testEnv).bootstrapToken,
        companyName: "GWP",
        email: "owner@example.test",
        password: "a-long-test-password-123!",
      });
      expect(res.status).toBe(201);
      await seedDemo(f.db, "demo");

      // Demo canvases exist for the legacy canvas owners (p7/thn/td/hr/l1).
      const canvases = await f
        .db("canvas")
        .join("app_user", "app_user.id", "=", "canvas.owner_user_id")
        .select("canvas.id", "app_user.name as owner_name");
      const owners = canvases.map((c: { owner_name: string }) => c.owner_name);
      for (const demoId of ["p7", "thn", "td", "hr", "l1"] as const) {
        expect(owners).toContain(DEMO_IDENTITIES[demoId].name);
      }

      // tc1 legacy had 1 full + 2 brief versions → 1 imported snapshot,
      // then the v3 weekly check-in version on top.
      const tc1 = canvases.find(
        (c: { owner_name: string }) =>
          c.owner_name === DEMO_IDENTITIES.p7.name,
      );
      const versions = await f
        .db("canvas_version")
        .where({ canvas_id: tc1.id })
        .orderBy("version_no");
      expect(versions).toHaveLength(2);
      const prov = versions[0].provenance as Record<string, unknown>;
      expect(prov.source).toBe("demo-seed");
      // The skipped briefs are recorded — not silently dropped, not faked.
      expect(prov.skippedBriefs).toEqual(expect.arrayContaining(["v1", "v2"]));
      expect(versions[1].provenance).toMatchObject({
        source: "demo-seed",
        kind: "weekly-checkins",
      });

      // current_version_id points at the check-in version, whose trend
      // derives from observed measurements: 3 layers × weeks T31–T33.
      const row = await f
        .db("canvas")
        .where({ id: tc1.id })
        .first();
      expect(row.current_version_id).toBe(versions[1].id);
      const series = buildSeries(versions[1].body as CanvasBody);
      expect(series.map((s) => s.points[0].layer).sort()).toEqual([
        "BEHAVIOR",
        "OUTPUT",
        "RESULT",
      ]);
      for (const s of series) expect(s.points).toHaveLength(3);

      // Re-seed is a no-op — same version count, no duplicates.
      await seedDemo(f.db, "demo");
      const again = await f
        .db("canvas_version")
        .where({ canvas_id: tc1.id });
      expect(again).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
});
