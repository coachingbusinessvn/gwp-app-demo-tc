import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_PASSWORD,
  fixture,
  personaEmail,
  testEnv,
  type Fixture,
  type Persona,
} from "../helpers/fixture.js";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm.js";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";

/**
 * Task 4.2 — ORACLE grader: ephemeral transcript, validated output,
 * explicit save (spec §6/§7.3).
 *
 *   POST /api/v1/ai/runs {assistant:"oracle", sessionId, transcript, ...}
 *   POST /api/v1/reports {sessionId, runId, idempotencyKey}
 *
 * The transcript exists only for the request/run lifetime — it is hashed
 * into ai_run.input_hash and NEVER persisted; the validated report is
 * saved from the server-side preview only (a client can never supply the
 * body). Report versions are immutable: re-grading appends a new version.
 * The marker string `raw-transcript-marker` sits inside the fixture
 * transcript precisely so the tests can prove it reaches no store.
 */

const cases = JSON.parse(
  readFileSync(
    new URL("../fixtures/ai/oracle-cases.json", import.meta.url),
    "utf8",
  ),
) as { transcript: string; validReport: string };

const MARKER = "raw-transcript-marker";

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

/** manager records a session coaching member — the common case. */
async function createSession(f: Fixture): Promise<string> {
  const res = await f.api("manager").post("/api/v1/coaching-sessions").send({
    coachUserId: f.ids.manager,
    coacheeUserId: f.ids.member,
    occurredAt: "2026-09-20T10:00:00.000Z",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Start an oracle run and poll until it leaves queued/running. */
async function oracleRun(
  f: Fixture,
  persona: Persona,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<{ runId: string; status: number }> {
  const r = await f
    .api(persona)
    .post("/api/v1/ai/runs")
    .send({
      assistant: "oracle",
      sessionId,
      transcript: cases.transcript,
      consent: true,
      idempotencyKey: `idem-${randomUUID()}`,
      ...extra,
    });
  if (r.status !== 201) return { runId: "", status: r.status };
  const runId = r.body.runId as string;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const g = await f.api(persona).get(`/api/v1/ai/runs/${runId}`);
    if (!["queued", "running"].includes(g.body.status)) {
      return { runId, status: r.status };
    }
    if (Date.now() > deadline) throw new Error("oracle run did not finish");
    await new Promise((res) => setTimeout(res, 150));
  }
}

function saveReport(
  f: Fixture,
  persona: Persona | undefined,
  body: Record<string, unknown>,
) {
  return f.api(persona).post("/api/v1/reports").send(body);
}

describe("ORACLE grader run (task 4.2)", () => {
  it("grades a transcript into a validated preview — transcript never persisted", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { runId } = await oracleRun(f, "manager", sessionId);
      expect(runId).not.toBe("");

      const pv = await f.api("manager").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.status).toBe(200);
      expect(pv.body.value.kind).toBe("oracle");
      expect(pv.body.value.output.scores).toEqual({
        O: 7, R: 6, A: 5, C: 5, L: 7, E: 8,
      });
      expect(pv.body.value.output.total).toBe(63);
      expect(pv.body.value.issues).toHaveLength(0);

      // The transcript reached the model but no store: the marker lives in
      // the fixture transcript and is never quoted by the report.
      const runRow = await f.db("ai_run").where({ id: runId }).first();
      expect(runRow.assistant).toBe("oracle");
      expect(runRow.session_id).toBe(sessionId);
      expect(runRow.canvas_id).toBeNull();
      expect(runRow.prompt_version).toBe("oracle-1.0.0");
      for (const table of ["ai_run", "audit_event", "coaching_session"]) {
        expect(
          JSON.stringify(await f.db(table).select("*")),
          table,
        ).not.toContain(MARKER);
      }
      // The fake LLM did receive the transcript (sanity: it went upstream).
      expect(JSON.stringify(llm.requests)).toContain(MARKER);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("requires consent and rejects mismatched session/canvas inputs", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const base = {
        assistant: "oracle",
        sessionId,
        transcript: cases.transcript,
        idempotencyKey: `idem-${randomUUID()}`,
      };
      // No consent → 400 AI_CONSENT_REQUIRED.
      const noConsent = await f.api("manager").post("/api/v1/ai/runs").send(base);
      expect(noConsent.status).toBe(400);
      expect(noConsent.body.code).toBe("AI_CONSENT_REQUIRED");
      // Oracle with canvasId instead of sessionId → 400.
      expect(
        (
          await f.api("manager").post("/api/v1/ai/runs").send({
            assistant: "oracle",
            canvasId: randomUUID(),
            transcript: cases.transcript,
            consent: true,
            idempotencyKey: `idem-${randomUUID()}`,
          })
        ).status,
      ).toBe(400);
      // Oracle without transcript → 400.
      expect(
        (
          await f.api("manager").post("/api/v1/ai/runs").send({
            assistant: "oracle",
            sessionId,
            consent: true,
            idempotencyKey: `idem-${randomUUID()}`,
          })
        ).status,
      ).toBe(400);
      // Canvas assistants still require canvasId.
      expect(
        (
          await f.api("member").post("/api/v1/ai/runs").send({
            assistant: "coach",
            sessionId,
            consent: true,
            idempotencyKey: `idem-${randomUUID()}`,
          })
        ).status,
      ).toBe(400);
      // Unknown session → 404; coachee/outsider → 404 (never reveal).
      for (const [persona, sid] of [
        ["manager", randomUUID()],
        ["member", sessionId],
        ["outsider", sessionId],
        ["admin", sessionId],
      ] as [Persona, string][]) {
        const res = await f
          .api(persona)
          .post("/api/v1/ai/runs")
          .send({ ...base, sessionId: sid, consent: true });
        expect(res.status, `${persona}/${sid}`).toBe(404);
      }
      // The session's own coach (manager) and owner may grade.
      expect((await oracleRun(f, "owner", sessionId)).runId).not.toBe("");
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("rejects fabricated quotes and wrong totals — invalid previews cannot save", async () => {
    const fabricated = cases.validReport.replace(
      "“Mục tiêu của buổi hôm nay là tìm cách phân bổ thời gian hợp lý — đúng không?”",
      "“Câu này không hề xuất hiện trong transcript.”",
    );
    const { f, llm } = await setup(llmMarkdown(fabricated));
    try {
      const sessionId = await createSession(f);
      const { runId } = await oracleRun(f, "manager", sessionId);
      const pv = await f.api("manager").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.body.value.output).toBeNull();
      expect(
        (pv.body.value.issues as { code: string }[]).some(
          (i) => i.code === "ORACLE_QUOTE_MISMATCH",
        ),
      ).toBe(true);
      // Save refuses an invalid preview — 422, no report row.
      const save = await saveReport(f, "manager", {
        sessionId,
        runId,
        idempotencyKey: "accept-report",
      });
      expect(save.status).toBe(422);
      expect(await f.db("coaching_report").select("id")).toHaveLength(0);

      // Wrong total on a second run → issues + unsaveable.
      llm.enqueue(
        llmMarkdown(cases.validReport.replace("Điểm tổng: 63/100", "Điểm tổng: 70/100")),
      );
      const second = await oracleRun(f, "manager", sessionId);
      const pv2 = await f
        .api("manager")
        .get(`/api/v1/ai/runs/${second.runId}/preview`);
      expect(pv2.body.value.output).toBeNull();
      expect(
        (pv2.body.value.issues as { code: string }[]).some(
          (i) => i.code === "ORACLE_TOTAL_MISMATCH",
        ),
      ).toBe(true);
    } finally {
      await f.close();
      await llm.close();
    }
  });
});

describe("POST /api/v1/reports — explicit save from preview", () => {
  it("saves version 1 from the validated preview; replay returns the same report; re-grade appends version 2", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { runId } = await oracleRun(f, "manager", sessionId);

      const saved = await saveReport(f, "manager", {
        sessionId,
        runId,
        idempotencyKey: "accept-report",
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(201);
      expect(saved.body).toMatchObject({ reportVersion: 1 });
      const reportId = saved.body.reportId as string;

      // Idempotent replay: same key → same report, still one row.
      const again = await saveReport(f, "manager", {
        sessionId,
        runId,
        idempotencyKey: "accept-report",
      });
      expect(again.body.reportId).toBe(reportId);
      expect(again.body.reportVersion).toBe(1);
      expect(await f.db("coaching_report").select("id")).toHaveLength(1);

      // The saved report is readable and carries provenance, not the run's
      // secrets — and never the transcript marker.
      const get = await f.api("manager").get(`/api/v1/reports/${reportId}`);
      expect(get.status).toBe(200);
      expect(get.body.rubricVersion).toBe("ORACLE-v3");
      expect(get.body.aiRunId).toBe(runId);
      expect(get.body.provenance).toMatchObject({ model: "pilot" });
      expect(JSON.stringify(get.body)).not.toContain(MARKER);

      // A second grading run on the same session saves as version 2.
      const second = await oracleRun(f, "manager", sessionId);
      const saved2 = await saveReport(f, "manager", {
        sessionId,
        runId: second.runId,
        idempotencyKey: "accept-report-2",
      });
      expect(saved2.status).toBe(201);
      expect(saved2.body.reportVersion).toBe(2);
      expect(saved2.body.reportId).not.toBe(reportId);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("a manager who lost the coachee relation keeps read but cannot save new versions", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { runId } = await oracleRun(f, "manager", sessionId);

      // Org change: member now reports to outsider — manager keeps the
      // coach identity (read) but cannot write new reports.
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ manager_id: f.ids.outsider });

      const save = await saveReport(f, "manager", {
        sessionId,
        runId,
        idempotencyKey: "accept-report",
      });
      expect(save.status).toBe(403);

      // A fresh run is denied too — write authority follows the current tree.
      const run = await f
        .api("manager")
        .post("/api/v1/ai/runs")
        .send({
          assistant: "oracle",
          sessionId,
          transcript: cases.transcript,
          consent: true,
          idempotencyKey: `idem-${randomUUID()}`,
        });
      expect(run.status).toBe(403);

      // Owner still saves the staged preview? No — previews belong to the
      // run's creator; owner's own run is required. Owner runs + saves fine.
      const ownerRun = await oracleRun(f, "owner", sessionId);
      const ownerSave = await saveReport(f, "owner", {
        sessionId,
        runId: ownerRun.runId,
        idempotencyKey: "owner-save",
      });
      expect(ownerSave.status).toBe(201);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("denies save for foreign runs, wrong assistant, non-succeeded runs and lost previews (410 after restart)", async () => {
    const { f, llm } = await setup(llmMarkdown(cases.validReport));
    try {
      const sessionId = await createSession(f);
      const { runId } = await oracleRun(f, "manager", sessionId);

      // The preview's owner is manager — owner cannot save manager's run.
      expect(
        (
          await saveReport(f, "owner", {
            sessionId,
            runId,
            idempotencyKey: "k1-foreign-run",
          })
        ).status,
      ).toBe(404);
      // Session mismatch and missing ids → uniform 404 / validation 400.
      expect(
        (
          await saveReport(f, "manager", {
            sessionId: randomUUID(),
            runId,
            idempotencyKey: "k2-bad-session",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await saveReport(f, "manager", {
            sessionId,
            runId: randomUUID(),
            idempotencyKey: "k3-bad-run",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await saveReport(f, "manager", {
            sessionId,
            runId,
            idempotencyKey: "x",
          })
        ).status,
      ).toBe(400);
      expect((await saveReport(f, undefined, { sessionId, runId })).status).toBe(
        401,
      );

      // "Restart": a second app instance over the same DB has an empty
      // preview store — the run row survives but the preview is gone → 410.
      const restartedApp = createApp({
        db: f.db,
        clock: () => new Date(),
        config: loadConfig({
          ...testEnv,
          AI_ALLOW_HTTP: "true",
          AI_ALLOWED_HOSTS: "127.0.0.1",
        }),
      });
      const login = await request(restartedApp)
        .post("/api/v1/auth/login")
        .set("Origin", testEnv.APP_ORIGIN!)
        .send({
          email: personaEmail("manager"),
          password: FIXTURE_PASSWORD,
        });
      expect(login.status).toBe(200);
      const res = await request(restartedApp)
        .post("/api/v1/reports")
        .set("Origin", testEnv.APP_ORIGIN!)
        .set("Authorization", `Bearer ${login.body.accessToken}`)
        .send({ sessionId, runId, idempotencyKey: "after-restart" });
      expect(res.status).toBe(410);
      expect(res.body.code).toBe("PREVIEW_EXPIRED");
    } finally {
      await f.close();
      await llm.close();
    }
  });
});
