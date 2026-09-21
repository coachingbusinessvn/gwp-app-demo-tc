import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, type Fixture, type Persona } from "../helpers/fixture.js";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm.js";

/**
 * Task 4.3 — explicit report sharing, confirmed delete, and the
 * report→Renderer bridge (spec §6).
 *
 *   PUT    /api/v1/reports/:id/shares/:userId   coach|owner only
 *   DELETE /api/v1/reports/:id/shares/:userId   coach|owner only
 *   DELETE /api/v1/reports/:id  {confirm:true}  coach|owner only
 *   POST   /api/v1/ai/runs {assistant:"renderer", canvasId, reportId,
 *                           reportFields?}      report-read ∧ canvas-write
 *
 * Shares bind ONE report row — a new version gets an empty share set.
 * The bridge never copies the whole report, transcript or coach scores
 * into the canvas prompt: only the whitelisted recommendation fields the
 * user selected are extracted server-side.
 */

const cases = JSON.parse(
  readFileSync(
    new URL("../fixtures/ai/oracle-cases.json", import.meta.url),
    "utf8",
  ),
) as { transcript: string; validReport: string };

const MARKER = "raw-transcript-marker";

const canonicalCanvas = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as unknown;

function llmMarkdown(content: string) {
  return {
    kind: "json" as const,
    body: {
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  };
}

async function setup(
  respondWith: ReturnType<typeof llmMarkdown>,
): Promise<{ f: Fixture; llm: FakeLlm }> {
  const llm = await fakeLlm({ respondWith });
  const port = new URL(llm.url).port;
  const f = await fixture({
    seeded: true,
    env: {
      AI_ALLOW_HTTP: "true",
      AI_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    },
  });
  try {
    const r = await f
      .api("owner")
      .put("/api/v1/settings/ai")
      .send({
        enabled: true,
        baseUrl: llm.url,
        apiKey: "local-secret",
        model: "pilot",
      });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  } catch (err) {
    await f.close();
    await llm.close();
    throw err;
  }
  return { f, llm };
}

async function createSession(f: Fixture): Promise<string> {
  const res = await f.api("manager").post("/api/v1/coaching-sessions").send({
    coachUserId: f.ids.manager,
    coacheeUserId: f.ids.member,
    occurredAt: "2026-09-20T10:00:00.000Z",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function oracleRun(f: Fixture, persona: Persona, sessionId: string) {
  const r = await f.api(persona).post("/api/v1/ai/runs").send({
    assistant: "oracle",
    sessionId,
    transcript: cases.transcript,
    consent: true,
    idempotencyKey: `idem-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const runId = r.body.runId as string;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const g = await f.api(persona).get(`/api/v1/ai/runs/${runId}`);
    if (!["queued", "running"].includes(g.body.status)) return runId;
    if (Date.now() > deadline) throw new Error("oracle run did not finish");
    await new Promise((res) => setTimeout(res, 150));
  }
}

/** Grade + save → the report id + run id of a fresh immutable version. */
async function saveReport(
  f: Fixture,
  persona: Persona,
  sessionId: string,
  key: string,
): Promise<{ reportId: string; runId: string }> {
  const runId = await oracleRun(f, persona, sessionId);
  const res = await f
    .api(persona)
    .post("/api/v1/reports")
    .send({ sessionId, runId, idempotencyKey: key });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { reportId: res.body.reportId as string, runId };
}

function share(f: Fixture, persona: Persona, reportId: string, userId: string) {
  return f.api(persona).put(`/api/v1/reports/${reportId}/shares/${userId}`);
}
function unshare(
  f: Fixture,
  persona: Persona,
  reportId: string,
  userId: string,
) {
  return f.api(persona).delete(`/api/v1/reports/${reportId}/shares/${userId}`);
}
function getReport(f: Fixture, persona: Persona, reportId: string) {
  return f.api(persona).get(`/api/v1/reports/${reportId}`);
}

describe("report sharing (task 4.3)", () => {
  it("coach shares one version; sharee reads exactly it; revoke denies from the next request", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { reportId: reportV1 } = await saveReport(
        f,
        "manager",
        sessionId,
        "save-v1-key",
      );

      // The coachee has no implicit read — share is the only door.
      expect((await getReport(f, "member", reportV1)).status).toBe(404);

      const granted = await share(f, "manager", reportV1, f.ids.member);
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
      expect((await getReport(f, "member", reportV1)).status).toBe(200);

      // A re-grade appends version 2 — a NEW report row with an empty
      // share set. The member still reads v1 but not v2.
      const { reportId: reportV2 } = await saveReport(
        f,
        "manager",
        sessionId,
        "save-v2-key",
      );
      expect(reportV2).not.toBe(reportV1);
      expect((await getReport(f, "member", reportV1)).status).toBe(200);
      expect((await getReport(f, "member", reportV2)).status).toBe(404);

      // Revoke takes effect from the very next request.
      expect((await unshare(f, "manager", reportV1, f.ids.member)).status).toBe(
        204,
      );
      expect((await getReport(f, "member", reportV1)).status).toBe(404);

      // Audit keeps the events with metadata only — never report content.
      const audit = await f
        .db("audit_event")
        .where("target_type", "coaching_report")
        .whereIn("action", [
          "coaching.report.share",
          "coaching.report.revoke",
        ])
        .orderBy("created_at");
      expect(audit).toHaveLength(2);
      expect(audit[0].action).toBe("coaching.report.share");
      expect(audit[1].action).toBe("coaching.report.revoke");
      for (const row of audit) {
        expect(row.safe_metadata.to).toBe(f.ids.member);
        expect(JSON.stringify(row)).not.toContain("Điểm tổng");
        expect(JSON.stringify(row)).not.toContain(MARKER);
      }
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("share management is coach/owner only — readers cannot re-share, strangers get 404", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { reportId } = await saveReport(f, "manager", sessionId, "save-own");

      // Nobody outside the ACL can even find the report to share it.
      for (const p of ["member", "outsider", "admin"] as Persona[]) {
        expect(
          (await share(f, p, reportId, f.ids.outsider)).status,
          p,
        ).toBe(404);
      }

      // A sharee reads but cannot re-share — grant rights stay with
      // coach/owner, they do not flow downstream.
      expect((await share(f, "manager", reportId, f.ids.member)).status).toBe(
        200,
      );
      expect((await getReport(f, "member", reportId)).status).toBe(200);
      expect(
        (await share(f, "member", reportId, f.ids.outsider)).status,
      ).toBe(403);
      expect((await unshare(f, "member", reportId, f.ids.member)).status).toBe(
        403,
      );

      // Owner can always manage shares; re-share after revoke works.
      expect((await share(f, "owner", reportId, f.ids.outsider)).status).toBe(
        200,
      );
      expect((await unshare(f, "owner", reportId, f.ids.outsider)).status).toBe(
        204,
      );
      expect((await share(f, "owner", reportId, f.ids.outsider)).status).toBe(
        200,
      );
      // Idempotent: sharing twice is fine; revoking a non-share is 404.
      expect((await share(f, "owner", reportId, f.ids.outsider)).status).toBe(
        200,
      );
      expect((await unshare(f, "owner", reportId, f.ids.admin)).status).toBe(
        404,
      );

      // Unknown targets and foreign companies are hidden uniformly.
      expect(
        (await share(f, "manager", reportId, randomUUID())).status,
      ).toBe(404);
      expect(
        (await share(f, "manager", randomUUID(), f.ids.member)).status,
      ).toBe(404);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("confirmed delete removes body and shares; audit keeps the event; receipts cannot resurrect", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { reportId, runId } = await saveReport(
        f,
        "manager",
        sessionId,
        "save-del",
      );
      expect((await share(f, "manager", reportId, f.ids.member)).status).toBe(
        200,
      );

      // Deletion requires the explicit confirm flag.
      expect(
        (
          await f.api("manager").delete(`/api/v1/reports/${reportId}`).send({})
        ).status,
      ).toBe(400);
      // A sharee cannot delete; the coach can.
      expect(
        (
          await f
            .api("member")
            .delete(`/api/v1/reports/${reportId}`)
            .send({ confirm: true })
        ).status,
      ).toBe(403);
      expect(
        (
          await f
            .api("manager")
            .delete(`/api/v1/reports/${reportId}`)
            .send({ confirm: true })
        ).status,
      ).toBe(204);

      // Body + shares are gone for everyone — including a fresh share lookup.
      expect((await getReport(f, "manager", reportId)).status).toBe(404);
      expect((await getReport(f, "member", reportId)).status).toBe(404);
      expect(await f.db("coaching_report").where({ id: reportId })).toHaveLength(
        0,
      );
      expect(await f.db("report_share").where({ report_id: reportId })).toHaveLength(
        0,
      );

      // Audit kept the deletion event — metadata only, no content.
      const audit = await f
        .db("audit_event")
        .where({ action: "coaching.report.delete", target_id: reportId })
        .first();
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit)).not.toContain("Điểm tổng");

      // Replaying the save receipt (same run, same key) must not resurrect
      // the deleted report — the stored result is gone, answer 404.
      const replay = await f.api("manager").post("/api/v1/reports").send({
        sessionId,
        runId,
        idempotencyKey: "save-del",
      });
      expect(replay.status).toBe(404);
      expect(await f.db("coaching_report").where({ id: reportId })).toHaveLength(
        0,
      );

      // Second delete is a plain 404.
      expect(
        (
          await f
            .api("manager")
            .delete(`/api/v1/reports/${reportId}`)
            .send({ confirm: true })
        ).status,
      ).toBe(404);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("renderer bridge needs report-read AND canvas-write; only whitelisted fields reach the model", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { reportId } = await saveReport(
        f,
        "manager",
        sessionId,
        "save-bridge",
      );
      expect((await share(f, "manager", reportId, f.ids.member)).status).toBe(
        200,
      );

      const canvasRes = await f.api("member").post("/api/v1/canvases").send({
        ownerUserId: f.ids.member,
        name: "Canvas của member",
        body: canonicalCanvas,
      });
      expect(canvasRes.status).toBe(201);
      const canvasId = canvasRes.body.id as string;

      // member: report share + own canvas → the run is admitted. The next
      // LLM call is the renderer's — script its answer (the grader call
      // already consumed the default oracle report).
      llm.enqueue(llmMarkdown(canonicalRendererOutput()));
      const started = await f.api("member").post("/api/v1/ai/runs").send({
        assistant: "renderer",
        canvasId,
        reportId,
        reportFields: ["priorities", "followUp"],
        consent: true,
        idempotencyKey: `bridge-${randomUUID()}`,
      });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const runId = started.body.runId as string;
      const deadline = Date.now() + 15_000;
      for (;;) {
        const g = await f.api("member").get(`/api/v1/ai/runs/${runId}`);
        if (!["queued", "running"].includes(g.body.status)) break;
        if (Date.now() > deadline) throw new Error("renderer run stuck");
        await new Promise((res) => setTimeout(res, 150));
      }

      // The model received ONLY the selected recommendations — never the
      // scorecard, per-step grades, evidence labels or raw transcript.
      // (requests.at(-1): the renderer call — earlier requests are the
      // oracle run, whose own system prompt mentions the label names.)
      const upstream = JSON.stringify(llm.requests.at(-1));
      expect(upstream).toContain("lượng hóa Key Result");
      expect(upstream).toContain("rút bài học");
      expect(upstream).not.toContain("63/100");
      expect(upstream).not.toContain("Bằng chứng trực tiếp");
      expect(upstream).not.toContain(MARKER);

      // Without the share the same request is a uniform 404 — the report
      // is invisible to outsider even though its canvas is writable.
      const outsiderCanvas = await f
        .api("outsider")
        .post("/api/v1/canvases")
        .send({
          ownerUserId: f.ids.outsider,
          name: "Canvas outsider",
          body: canonicalCanvas,
        });
      expect(outsiderCanvas.status).toBe(201);
      expect(
        (
          await f.api("outsider").post("/api/v1/ai/runs").send({
            assistant: "renderer",
            canvasId: outsiderCanvas.body.id,
            reportId,
            consent: true,
            idempotencyKey: `bridge-${randomUUID()}`,
          })
        ).status,
      ).toBe(404);

      // Report access without canvas write is equally denied.
      const foreignCanvas = await f.api("owner").post("/api/v1/canvases").send({
        ownerUserId: f.ids.outsider,
        name: "Canvas outsider 2",
        body: canonicalCanvas,
      });
      expect(
        (
          await f.api("member").post("/api/v1/ai/runs").send({
            assistant: "renderer",
            canvasId: foreignCanvas.body.id,
            reportId,
            consent: true,
            idempotencyKey: `bridge-${randomUUID()}`,
          })
        ).status,
      ).toBe(404);

      // reportId/reportFields belong to renderer only; unknown fields and
      // non-whitelisted paths are 400, not silently dropped.
      for (const body of [
        { assistant: "oracle", sessionId, transcript: cases.transcript, reportId },
        { assistant: "coach", canvasId, reportId },
        { assistant: "renderer", canvasId, reportId, reportFields: ["scores"] },
        { assistant: "renderer", canvasId, reportId, reportFields: ["bogus"] },
        { assistant: "renderer", reportId },
      ]) {
        expect(
          (
            await f.api("member").post("/api/v1/ai/runs").send({
              consent: true,
              idempotencyKey: `bridge-${randomUUID()}`,
              ...body,
            })
          ).status,
          JSON.stringify(body),
        ).toBe(400);
      }
    } finally {
      await f.close();
      await llm.close();
    }
  });
});

/**
 * Minimal renderer output — the bridge test only inspects what the run
 * SENT upstream; whether this parses as a canvas proposal is irrelevant.
 */
function canonicalRendererOutput(): string {
  return "(đề xuất mô phỏng — test chỉ kiểm tra phía request)";
}
