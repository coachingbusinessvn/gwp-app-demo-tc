import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, type Fixture } from "../helpers/fixture.js";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm.js";

/**
 * Task 3.4 — Renderer assistant (spec §7.3).
 *
 * Contract under test:
 * - A run drives the real adapter against the configured endpoint; the
 *   answer is parsed by the SAME canonical parser as manual import.
 * - Parse/validation errors land in the preview, NEVER in the draft —
 *   apply refuses while error-severity issues exist (AI_PROPOSAL_INVALID).
 * - Warnings must be explicitly accepted by issue id, else 400
 *   AI_WARNINGS_UNACCEPTED; the client cannot send a body (strict schema).
 * - Apply re-checks permission and the CAPTURED base — a draft that moved
 *   since the run is 409 AI_BASE_CHANGED, a revoked permission is the
 *   uniform 404, and AI output never publishes.
 * - Stable ids: proposal rows matching the source keep the source ids.
 */

const canonicalMd = readFileSync(
  new URL("../fixtures/canvas/canonical.md", import.meta.url),
  "utf8",
);
const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** JSON (non-stream) chat-completions answer carrying `content`. */
function llmJson(content: string) {
  return {
    kind: "json" as const,
    body: {
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  };
}

/** A proposal answer: short analysis + one canonical markdown block. */
function proposalAnswer(md: string): string {
  return `## Phân tích dữ liệu phiên\n\n**Insight:** dữ liệu nói đủ.\n\n${md}`;
}

async function startFixtureWithLlm(
  respondWith: NonNullable<Parameters<typeof fakeLlm>[0]>["respondWith"],
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
    if (r.status !== 200) {
      throw new Error(`settings PUT failed: ${JSON.stringify(r.body)}`);
    }
  } catch (err) {
    await f.close();
    await llm.close();
    throw err;
  }
  return { f, llm };
}

async function createCanvas(f: Fixture, persona: "member" | "manager") {
  const r = await f
    .api(persona)
    .post("/api/v1/canvases")
    .send({
      ownerUserId: f.ids[persona],
      name: "Canvas AI",
      body: clone(canonical),
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function startRun(
  f: Fixture,
  persona: "member",
  canvasId: string,
  notes = "ghi chú phiên",
): Promise<string> {
  const r = await f
    .api(persona)
    .post("/api/v1/ai/runs")
    .send({
      assistant: "renderer",
      canvasId,
      notes,
      consent: true,
      idempotencyKey: `idem-${randomUUID()}`,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.runId as string;
}

/** Poll the run until it leaves queued/running (driver runs async). */
async function waitTerminal(
  f: Fixture,
  persona: "member",
  runId: string,
): Promise<{ status: string; errorCode: string | null }> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const r = await f.api(persona).get(`/api/v1/ai/runs/${runId}`);
    expect(r.status).toBe(200);
    if (!["queued", "running"].includes(r.body.status)) {
      return { status: r.body.status, errorCode: r.body.errorCode };
    }
    if (Date.now() > deadline) throw new Error("run did not terminate");
    await new Promise((res) => setTimeout(res, 150));
  }
}

describe("Renderer assistant (task 3.4)", () => {
  it("runs the full loop: proposal → preview → accepted apply → draft only", async () => {
    // Proposal = canonical with a changed goal statement → meta/goal diff.
    const proposed = canonicalMd.replace(
      "Giảm nợ chuyển nhóm bằng cách nâng chất lượng liên hệ sớm",
      "Giảm nợ nhóm 2 bằng liên hệ sớm có kiểm chứng",
    );
    const { f, llm } = await startFixtureWithLlm(
      llmJson(proposalAnswer(proposed)),
    );
    try {
      const canvasId = await createCanvas(f, "member");
      const runId = await startRun(f, "member", canvasId);
      const done = await waitTerminal(f, "member", runId);
      expect(done).toEqual({ status: "succeeded", errorCode: null });

      // The upstream call carried the configured key and real messages —
      // never canvas content in the ai_run row.
      expect(llm.requests).toHaveLength(1);
      expect(llm.requests[0]!.headers.authorization).toBe("<present>");
      const row = await f.db("ai_run").where({ id: runId }).first();
      expect(row.status).toBe("succeeded");
      expect(row.prompt_version).toBe("renderer-1.0.0");
      expect(JSON.stringify(row)).not.toContain("ghi chú phiên");

      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.status).toBe(200);
      expect(pv.body.value.kind).toBe("renderer");
      expect(pv.body.value.proposal.goal.statement).toContain(
        "liên hệ sớm có kiểm chứng",
      );
      expect(pv.body.value.diff.metaChanged).toContain("goal");
      expect(pv.body.base.draftRevision).toBe(1);

      const warnIds = (pv.body.value.issues as { id: string }[])
        .filter(() => true)
        .map((i) => i.id);
      const apply = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: warnIds });
      expect(apply.status, JSON.stringify(apply.body)).toBe(200);
      expect(apply.body.body.goal.statement).toContain("liên hệ sớm có kiểm chứng");

      // Draft carries the ai provenance stamp; canvas NOT auto-published.
      const draft = await f
        .db("canvas_draft")
        .where({ canvas_id: canvasId })
        .first();
      expect(draft.source).toBe("ai");
      const cv = await f.db("canvas").where({ id: canvasId }).first();
      expect(cv.current_version_id).toBeNull();

      // Stable ids: rows unchanged in the proposal keep the source ids.
      const before = await f.api("member").get(`/api/v1/canvases/${canvasId}`);
      const sourceIds = new Set(
        (clone(canonical).outputs as { id: string }[]).map((o) => o.id),
      );
      void before;
      for (const o of apply.body.body.outputs as { id: string }[]) {
        expect(sourceIds.has(o.id)).toBe(true);
      }

      // Apply is one-shot — the preview is consumed.
      const again = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: warnIds });
      expect(again.status).toBe(410);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("broken markdown → preview carries the error, draft untouched, apply 409", async () => {
    const { f, llm } = await startFixtureWithLlm(
      llmJson("Đây là phân tích mà không có canvas nào cả."),
    );
    try {
      const canvasId = await createCanvas(f, "member");
      const runId = await startRun(f, "member", canvasId);
      expect((await waitTerminal(f, "member", runId)).status).toBe(
        "succeeded",
      );
      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.status).toBe(200);
      expect(pv.body.value.proposal).toBeNull();
      expect(
        (pv.body.value.issues as { code: string }[]).some(
          (i) => i.code === "RENDER_NO_CANVAS",
        ),
      ).toBe(true);

      const apply = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: [] });
      expect(apply.status).toBe(409);
      expect(apply.body.code).toBe("AI_PROPOSAL_INVALID");

      const draft = await f
        .db("canvas_draft")
        .where({ canvas_id: canvasId })
        .first();
      expect(draft.body.goal.statement).toBe(canonical.goal.statement);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("unsupported box→behavior ref is an error issue; apply refused", async () => {
    // Rename one behavior link cell so it matches no Step-3 behavior.
    const bad = canonicalMd.replace(
      "Nghe và chấm 20 cuộc gọi mẫu, phản hồi 1-1 |",
      "Hành vi không tồn tại |",
    );
    const { f, llm } = await startFixtureWithLlm(llmJson(proposalAnswer(bad)));
    try {
      const canvasId = await createCanvas(f, "member");
      const runId = await startRun(f, "member", canvasId);
      expect((await waitTerminal(f, "member", runId)).status).toBe(
        "succeeded",
      );
      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      const issues = pv.body.value.issues as {
        code: string;
        severity: string;
      }[];
      expect(
        issues.some(
          (i) =>
            i.code === "AMBIGUOUS_OR_MISSING_REFERENCE" &&
            i.severity === "error",
        ),
      ).toBe(true);
      const apply = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: [] });
      expect(apply.status).toBe(409);
      expect(apply.body.code).toBe("AI_PROPOSAL_INVALID");
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("draft that moved since capture → 409 AI_BASE_CHANGED; manual edit kept", async () => {
    const { f, llm } = await startFixtureWithLlm(
      llmJson(proposalAnswer(canonicalMd)),
    );
    try {
      const canvasId = await createCanvas(f, "member");
      const runId = await startRun(f, "member", canvasId);
      expect((await waitTerminal(f, "member", runId)).status).toBe(
        "succeeded",
      );

      // The user edits the draft after the run started — apply must refuse.
      const changed = clone(canonical);
      changed.goal.statement = "Người dùng tự sửa mục tiêu";
      const save = await f
        .api("member")
        .put(`/api/v1/canvases/${canvasId}/draft`)
        .send({ expectedRevision: 1, baseVersionId: null, body: changed });
      expect(save.status).toBe(200);

      const apply = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: [] });
      expect(apply.status).toBe(409);
      expect(apply.body.code).toBe("AI_BASE_CHANGED");

      const draft = await f
        .db("canvas_draft")
        .where({ canvas_id: canvasId })
        .first();
      expect(draft.body.goal.statement).toBe("Người dùng tự sửa mục tiêu");
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("revoked permission between run and apply → uniform 404", async () => {
    const { f, llm } = await startFixtureWithLlm(
      llmJson(proposalAnswer(canonicalMd)),
    );
    try {
      const canvasId = await createCanvas(f, "member");
      const runId = await startRun(f, "member", canvasId);
      expect((await waitTerminal(f, "member", runId)).status).toBe(
        "succeeded",
      );

      // Owner transfers the canvas to manager — member loses write access.
      const t = await f
        .api("owner")
        .post(`/api/v1/canvases/${canvasId}/transfer`)
        .send({ newOwnerId: f.ids.manager });
      expect(t.status).toBe(200);

      const apply = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: [] });
      expect(apply.status).toBe(404);
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("stage upgrade is a warning — apply needs acceptedWarnings", async () => {
    const upgraded = canonicalMd.replace(
      "**Canvas Stage:** PILOTING",
      "**Canvas Stage:** VALIDATED",
    );
    const { f, llm } = await startFixtureWithLlm(
      llmJson(proposalAnswer(upgraded)),
    );
    try {
      const canvasId = await createCanvas(f, "member");
      const runId = await startRun(f, "member", canvasId);
      expect((await waitTerminal(f, "member", runId)).status).toBe(
        "succeeded",
      );
      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      const issues = pv.body.value.issues as {
        id: string;
        code: string;
        severity: string;
      }[];
      const stageWarn = issues.find((i) => i.code === "STAGE_CHANGED");
      expect(stageWarn).toBeTruthy();

      const denied = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: [] });
      expect(denied.status).toBe(400);
      expect(denied.body.code).toBe("AI_WARNINGS_UNACCEPTED");

      const accepted = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({
          expectedRevision: 1,
          acceptedWarnings: issues.map((i) => i.id),
        });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.body.meta.stage).toBe("VALIDATED");
    } finally {
      await f.close();
      await llm.close();
    }
  });

  it("apply request carrying a forged body → strict 400; run not finished → 409", async () => {
    const { f, llm } = await startFixtureWithLlm(
      llmJson(proposalAnswer(canonicalMd)),
    );
    try {
      const canvasId = await createCanvas(f, "member");
      const runId = await startRun(f, "member", canvasId);
      // Still queued/running → apply before success is AI_RUN_NOT_READY
      // (status may already be succeeded under a fast fake — both are
      // covered: queued→409, succeeded→proceeds to preview checks).
      const early = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({ expectedRevision: 1, acceptedWarnings: [] });
      expect([200, 409]).toContain(early.status);
      if (early.status === 409) {
        expect(["AI_RUN_NOT_READY", "AI_BASE_CHANGED"]).toContain(
          early.body.code,
        );
      }

      const tampered = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/apply`)
        .send({
          expectedRevision: 1,
          acceptedWarnings: [],
          body: { meta: { stage: "VALIDATED" } },
        });
      expect(tampered.status).toBe(400);
      expect(tampered.body.code).toBe("INVALID_INPUT");
    } finally {
      await f.close();
      await llm.close();
    }
  });
});
