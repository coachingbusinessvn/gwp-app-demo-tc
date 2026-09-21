import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config.js";
import { createAiRunsService } from "../../server/src/modules/ai/runs.js";
import { createPreviewStore } from "../../server/src/modules/ai/preview.js";
import { fixture, testEnv, type Fixture } from "../helpers/fixture.js";

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
);

/**
 * Task 3.3 — AI run lifecycle (spec §7.3).
 *
 * Contract under test:
 * - consent:true is REQUIRED — absent/false → 400 AI_CONSENT_REQUIRED.
 * - idempotencyKey required; same key+same input replays the same runId;
 *   same key+different input → 409 AI_IDEMPOTENCY_CONFLICT.
 * - AI must be configured AND enabled: 503 AI_NOT_CONFIGURED /
 *   409 AI_DISABLED before admission even reaches the canvas.
 * - At most 2 active (queued|running) runs per company → 429 AI_BUSY.
 * - A run is visible only to its creator — every other persona gets 404.
 * - cancel: queued/running → cancelled; terminal → 409 AI_RUN_FINISHED.
 * - Preview: in-memory only, creator only, 410 when missing/expired.
 * - Boot sweep flips leftover queued/running rows to 'interrupted'.
 * - ai_run rows NEVER carry raw notes/content — only input_hash.
 * - Run admission reuses the canvas write gate: foreign canvas 404,
 *   archived canvas 409.
 */

const AI_SETTINGS = {
  enabled: true,
  baseUrl: "https://llm.internal:8443/v1",
  apiKey: "local-secret",
  model: "pilot",
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Owner configures AI so member runs can be admitted. */
async function configureAi(f: Fixture): Promise<void> {
  const r = await f.api("owner").put("/api/v1/settings/ai").send(AI_SETTINGS);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function createCanvasFor(
  f: Fixture,
  persona: "member" | "manager",
): Promise<string> {
  const ownerId = f.ids[persona];
  const r = await f
    .api(persona)
    .post("/api/v1/canvases")
    .send({ ownerUserId: ownerId, name: "Canvas AI", body: clone(canonical) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

function startBody(canvasId: string, extra: Record<string, unknown> = {}) {
  return {
    assistant: "renderer",
    canvasId,
    consent: true,
    idempotencyKey: `idem-${randomUUID()}`,
    ...extra,
  };
}

describe("AI runs (task 3.3)", () => {
  it("rejects missing/false consent and a missing idempotency key", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");

      const noConsent = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send({ ...startBody(canvasId), consent: undefined });
      expect(noConsent.status).toBe(400);
      expect(noConsent.body.code).toBe("AI_CONSENT_REQUIRED");

      const falseConsent = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send({ ...startBody(canvasId), consent: false });
      expect(falseConsent.status).toBe(400);
      expect(falseConsent.body.code).toBe("AI_CONSENT_REQUIRED");

      const noKey = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send({ assistant: "renderer", canvasId, consent: true });
      expect(noKey.status).toBe(400);
      expect(noKey.body.code).toBe("INVALID_INPUT");
    } finally {
      await f.close();
    }
  });

  it("503 AI_NOT_CONFIGURED before settings; 409 AI_DISABLED when disabled", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      const canvasId = await createCanvasFor(f, "member");
      const un = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      expect(un.status).toBe(503);
      expect(un.body.code).toBe("AI_NOT_CONFIGURED");

      await configureAi(f);
      const off = await f
        .api("owner")
        .put("/api/v1/settings/ai")
        .send({ ...AI_SETTINGS, enabled: false });
      expect(off.status).toBe(200);
      const disabled = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      expect(disabled.status).toBe(409);
      expect(disabled.body.code).toBe("AI_DISABLED");
    } finally {
      await f.close();
    }
  });

  it("starts a queued run; metadata only — notes never reach the row", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");
      const secretNotes = "ghi chú mật của người dùng";
      const r = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId, { notes: secretNotes }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.status).toBe("queued");
      const runId = r.body.runId as string;

      const g = await f.api("member").get(`/api/v1/ai/runs/${runId}`);
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({
        runId,
        assistant: "renderer",
        canvasId,
        status: "queued",
      });
      expect(JSON.stringify(g.body)).not.toContain(secretNotes);

      const row = await f.db("ai_run").where({ id: runId }).first();
      expect(row).toBeTruthy();
      expect(row.consent_at).toBeTruthy();
      expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(secretNotes);
      // Base snapshot captured at admission: canvas has no version yet
      // and its shared draft is at the initial revision.
      expect(row.base_version_id).toBeNull();
      expect(row.captured_draft_revision).toBe(1);
      expect(row.config_model).toBe("pilot");
    } finally {
      await f.close();
    }
  });

  it("idempotent replay returns the same run; different input → 409", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");
      const key = `idem-${randomUUID()}`;

      const a = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId, { idempotencyKey: key, notes: "n1" }));
      expect(a.status).toBe(201);

      const replay = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId, { idempotencyKey: key, notes: "n1" }));
      expect(replay.status).toBe(200);
      expect(replay.body.runId).toBe(a.body.runId);
      expect(replay.body.replayed).toBe(true);

      const conflict = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId, { idempotencyKey: key, notes: "khác" }));
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe("AI_IDEMPOTENCY_CONFLICT");

      const rows = await f.db("ai_run").where({ idempotency_key: key });
      expect(rows).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("caps at 2 active runs per company → 429 AI_BUSY", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");
      const r1 = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      const r2 = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      const r3 = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      expect(r3.status).toBe(429);
      expect(r3.body.code).toBe("AI_BUSY");
    } finally {
      await f.close();
    }
  });

  it("foreign canvas → 404; archived canvas → 409; other personas → 404", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const foreign = randomUUID();
      const nf = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(foreign));
      expect(nf.status).toBe(404);

      const canvasId = await createCanvasFor(f, "member");
      // Archive through the real API so the run gate sees the real state.
      const arc = await f
        .api("member")
        .post(`/api/v1/canvases/${canvasId}/archive`);
      expect(arc.status).toBe(200);
      const ar = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      expect(ar.status).toBe(409);

      // Ownership: manager cannot see or cancel member's run.
      const canvas2 = await createCanvasFor(f, "member");
      const start = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvas2));
      expect(start.status).toBe(201);
      const runId = start.body.runId;
      for (const p of ["manager", "owner", "outsider"] as const) {
        expect(
          (await f.api(p).get(`/api/v1/ai/runs/${runId}`)).status,
        ).toBe(404);
        expect(
          (await f.api(p).post(`/api/v1/ai/runs/${runId}/cancel`)).status,
        ).toBe(404);
        expect(
          (await f.api(p).get(`/api/v1/ai/runs/${runId}/preview`)).status,
        ).toBe(404);
      }
      expect((await f.api().get(`/api/v1/ai/runs/${runId}`)).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("cancel: queued → cancelled; finished → 409; preview → 410", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");
      const start = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      const runId = start.body.runId as string;

      const pv = await f.api("member").get(`/api/v1/ai/runs/${runId}/preview`);
      expect(pv.status).toBe(410);
      expect(pv.body.code).toBe("PREVIEW_EXPIRED");

      const c = await f.api("member").post(`/api/v1/ai/runs/${runId}/cancel`);
      expect(c.status).toBe(200);
      expect(c.body.status).toBe("cancelled");

      const again = await f
        .api("member")
        .post(`/api/v1/ai/runs/${runId}/cancel`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("AI_RUN_FINISHED");
    } finally {
      await f.close();
    }
  });

  it("terminal run's events stream emits its status then ends", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");
      const start = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      const runId = start.body.runId as string;
      await f.api("member").post(`/api/v1/ai/runs/${runId}/cancel`);

      const res = await f
        .api("member")
        .get(`/api/v1/ai/runs/${runId}/events`)
        .buffer(true)
        .parse((r, cb) => {
          let data = "";
          r.on("data", (c: Buffer) => {
            data += c.toString("utf8");
          });
          r.on("end", () => cb(null, data));
        });
      expect(res.status).toBe(200);
      expect(String(res.body)).toContain('"status":"cancelled"');
    } finally {
      await f.close();
    }
  });

  it("boot sweep marks leftover queued/running rows interrupted", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");
      const start = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      const runId = start.body.runId as string;

      const svc = createAiRunsService({
        db: f.db,
        clock: () => new Date(),
        config: loadConfig(testEnv),
      });
      expect(await svc.markInterruptedRuns()).toBe(1);
      const row = await f.db("ai_run").where({ id: runId }).first();
      expect(row.status).toBe("interrupted");

      // An interrupted run is terminal: cancel → 409.
      const c = await f.api("member").post(`/api/v1/ai/runs/${runId}/cancel`);
      expect(c.status).toBe(409);
    } finally {
      await f.close();
    }
  });

  it("registered driver: dispatch runs to succeeded, preview readable by creator only", async () => {
    const f = await fixture({ seeded: true, aiDrivers: {} });
    try {
      await configureAi(f);
      const canvasId = await createCanvasFor(f, "member");
      const start = await f
        .api("member")
        .post("/api/v1/ai/runs")
        .send(startBody(canvasId));
      const runId = start.body.runId as string;

      const svc = createAiRunsService({
        db: f.db,
        clock: () => new Date(),
        config: loadConfig(testEnv),
        previewStore: createPreviewStore(),
      });
      const events: string[] = [];
      svc.subscribe(runId, (e) => events.push(e.type));
      svc.registerDriver("renderer", async ({ emit }) => {
        emit({ type: "delta", text: "{…}" });
        return { preview: { kind: "patch", ops: [] }, usage: undefined };
      });
      await svc.dispatch(runId, f.ids.company);

      const row = await f.db("ai_run").where({ id: runId }).first();
      expect(row.status).toBe("succeeded");
      expect(events).toContain("delta");
      expect(events).toContain("done");

      // Preview only exists inside THIS service's store (per-process);
      // read it through the same service to prove creator-only access.
      const member = f.actor("member");
      const p = await svc.getPreview(member, runId);
      expect(p.base).toEqual({
        baseVersionId: null,
        draftRevision: 1,
      });
      expect(p.value).toMatchObject({ kind: "patch" });
      await expect(svc.getPreview(f.actor("manager"), runId)).rejects.toThrow(
        /Không tìm thấy/,
      );
    } finally {
      await f.close();
    }
  });
});
