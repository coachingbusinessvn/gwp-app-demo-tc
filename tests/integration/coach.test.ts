import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, type Fixture } from "../helpers/fixture.js";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm.js";

/**
 * Task 3.5 — Coach assistant integration: a coach run grades the canvas
 * and stages a read-only preview. Invalid model output lands as preview
 * issues (never a crash, never persisted), and coach previews can never
 * be applied — the coach does not mutate canvases.
 */

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
);
const cases = JSON.parse(
  readFileSync(
    new URL("../fixtures/ai/coach-cases.json", import.meta.url),
    "utf8",
  ),
) as { valid: Record<string, unknown> };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function llmJson(content: string) {
  return {
    kind: "json" as const,
    body: {
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  };
}

async function setup(
  respondWith: ReturnType<typeof llmJson>,
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

async function coachRun(f: Fixture): Promise<string> {
  const created = await f
    .api("member")
    .post("/api/v1/canvases")
    .send({ ownerUserId: f.ids.member, name: "Canvas coach", body: clone(canonical) });
  expect(created.status).toBe(201);
  const r = await f
    .api("member")
    .post("/api/v1/ai/runs")
    .send({
      assistant: "coach",
      canvasId: created.body.id,
      notes: "chấm giúp",
      consent: true,
      idempotencyKey: `idem-${randomUUID()}`,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const runId = r.body.runId as string;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const g = await f.api("member").get(`/api/v1/ai/runs/${runId}`);
    if (!["queued", "running"].includes(g.body.status)) return runId;
    if (Date.now() > deadline) throw new Error("coach run did not finish");
    await new Promise((res) => setTimeout(res, 150));
  }
}

describe("Coach assistant (task 3.5)", () => {
  it("grades the canvas into a validated, read-only preview", async () => {
    const { f, llm } = await setup(llmJson(JSON.stringify(cases.valid)));
    try {
      const runId = await coachRun(f);
      const g = await f.api("member").get(`/api/v1/ai/runs/${runId}`);
      expect(g.body.status).toBe("succeeded");

      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.status).toBe(200);
      expect(pv.body.value.kind).toBe("coach");
      expect(pv.body.value.output.total).toBe(69);
      expect(pv.body.value.issues).toHaveLength(0);
      expect(pv.body.value.canvasStage).toBe("PILOTING");

      // The row records provenance only — never the JSON content.
      const row = await f.db("ai_run").where({ id: runId }).first();
      expect(row.prompt_version).toBe("coach-1.0.0");
      expect(JSON.stringify(row)).not.toContain("chấm giúp");

      // Coach previews are advice-only: apply refuses for non-renderer.
      const apply = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: [] });
      expect(apply.status).toBe(400);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("malformed model output → preview issues, run still inspectable", async () => {
    const { f, llm } = await setup(
      llmJson("{\"rubricVersion\":\"3.0\",\"criteria\":[{\"id\":\"goal\""),
    );
    try {
      const runId = await coachRun(f);
      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.status).toBe(200);
      expect(pv.body.value.output).toBeNull();
      expect(
        (pv.body.value.issues as { code: string }[]).some(
          (i) => i.code === "COACH_OUTPUT_INVALID",
        ),
      ).toBe(true);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("rubric violation (invented ref) → preview issue, canvas untouched", async () => {
    const bad = clone(cases.valid);
    (bad.criteria as Record<string, unknown>[])[1] = {
      ...(bad.criteria as Record<string, unknown>[])[1],
      evidenceRefs: ["invented-row-id"],
    };
    const { f, llm } = await setup(llmJson(JSON.stringify(bad)));
    try {
      const runId = await coachRun(f);
      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.body.value.output).toBeNull();
      expect(
        (pv.body.value.issues as { code: string }[]).some(
          (i) => i.code === "UNKNOWN_EVIDENCE_REFERENCE",
        ),
      ).toBe(true);
    } finally {
      await f.close();
      await llm.close();
    }
  });
});
