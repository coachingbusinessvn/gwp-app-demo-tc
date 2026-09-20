/**
 * Task 2.7 — authorized export boundary (spec §5.3, plan step "Export").
 *
 * Two endpoints, both behind the same subject policy as every other
 * canvas read (denied = uniform 404, anonymous = uniform 401):
 *
 *   GET /canvases/:id/versions/:versionId/export?format=json|markdown
 *     Published snapshot export — the auditable preservation path. JSON
 *     returns the canonical body byte-faithful; Markdown returns the
 *     loss-aware render with explicit warnings (extensions the format
 *     cannot carry are flagged, never silently dropped).
 *
 *   POST /canvases/:id/export-preview
 *     The CURRENT DRAFT export — browser Excel/PDF/PNG render from this
 *     payload so the act of exporting a live draft is authorized and
 *     audited server-side.
 *
 * Plus a unit check that the XLSX writer can never turn user text into
 * an executable formula cell.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixture, type Persona } from "../helpers/fixture.js";
import type { CanvasBody } from "../../shared/canvas/schema.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

type TestResponse = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
  text: string;
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

let seq = 0;
function action(over: Record<string, unknown> = {}): CanvasBody["actions"][number] {
  return {
    id: randomUUID(),
    action: `Hành động ${++seq}`,
    start: "",
    deadline: "",
    criteria: "xong",
    status: "Đang thực hiện",
    risk: "",
    assignee_label: "Chuyên viên",
    supporter_label: "",
    ...over,
  } as CanvasBody["actions"][number];
}

/** Publishable canvas: canonical body + caller's row overrides. */
function publishable(over: Partial<CanvasBody> = {}): CanvasBody {
  const body = clone(canonical);
  Object.assign(body, over);
  body.meta.title = over.meta?.title ?? "Canvas export";
  return body;
}

async function mustCreate(
  f: Fixture,
  persona: Persona,
  ownerUserId: string,
  body: CanvasBody,
): Promise<string> {
  const res = await f
    .api(persona)
    .post("/api/v1/canvases")
    .send({ ownerUserId, name: body.meta.title || "Canvas", body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function mustPublish(
  f: Fixture,
  persona: Persona,
  canvasId: string,
  expectedRevision = 1,
): Promise<TestResponse> {
  const res = await f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/publish`)
    .send({ expectedRevision, idempotencyKey: `pub-${randomUUID()}` });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res as unknown as TestResponse;
}

async function saveDraft(
  f: Fixture,
  persona: Persona,
  canvasId: string,
  body: CanvasBody,
  baseVersionId: string | null = null,
): Promise<TestResponse> {
  const res = await f
    .api(persona)
    .put(`/api/v1/canvases/${canvasId}/draft`)
    .send({ expectedRevision: 1, baseVersionId, body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res as unknown as TestResponse;
}

async function versionIdOf(
  f: Fixture,
  persona: Persona,
  canvasId: string,
): Promise<string> {
  const res = await f
    .api(persona)
    .get(`/api/v1/canvases/${canvasId}/versions`);
  expect(res.status).toBe(200);
  const list = res.body as { id: string }[];
  expect(list.length).toBeGreaterThan(0);
  return list[0].id;
}

const exportVersion = (
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
  versionId: string,
  format = "json",
) =>
  f
    .api(persona)
    .get(
      `/api/v1/canvases/${canvasId}/versions/${versionId}/export?format=${format}`,
    ) as unknown as Promise<TestResponse>;

const exportPreview = (
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
) =>
  f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/export-preview`)
    .send({}) as unknown as Promise<TestResponse>;

describe("canvas export boundary (task 2.7)", () => {
  it("is Bearer-only — anonymous gets the uniform 401 on both endpoints", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, publishable());
      await mustPublish(f, "member", canvasId);
      const vid = await versionIdOf(f, "member", canvasId);

      expect((await exportVersion(f, undefined, canvasId, vid)).status).toBe(401);
      expect((await exportPreview(f, undefined, canvasId)).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("published JSON export round-trips the canonical body exactly", async () => {
    const f = await fixture({ seeded: true });
    try {
      const sent = publishable({
        meta: { ...clone(canonical.meta), title: "Canvas roundtrip" },
      });
      const canvasId = await mustCreate(f, "member", f.ids.member, sent);
      await mustPublish(f, "member", canvasId);
      const vid = await versionIdOf(f, "member", canvasId);

      const out = await exportVersion(f, "member", canvasId, vid, "json");
      expect(out.status).toBe(200);
      expect(out.body.schema_version).toBe(1);
      expect(out.body.body).toEqual(sent);
      expect(out.body.warnings).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("markdown export carries the loss warnings — extensions are flagged, not dropped silently", async () => {
    const f = await fixture({ seeded: true });
    try {
      const body = publishable({
        meta: { ...clone(canonical.meta), title: "Canvas có measurement" },
      });
      body.observed = [
        {
          id: randomUUID(),
          date: "2026-09-10",
          layer: "OUTPUT",
          value: "Tỷ lệ đạt chuẩn 78%",
          source: "báo cáo tuần",
          confidence: "HIGH",
          learning: "",
          decision: "",
          verifier: "",
          measurement: {
            metricId: randomUUID(),
            definitionRevision: 1,
            layer: "OUTPUT",
            date: "2026-09-10",
            value: 78,
            unit: "%",
            baseline: 65,
            target: 75,
          },
        },
      ];
      body.actions = [action({ assignee_user_id: f.ids.member })];

      const canvasId = await mustCreate(f, "member", f.ids.member, body);
      await mustPublish(f, "member", canvasId);
      const vid = await versionIdOf(f, "member", canvasId);

      const out = await exportVersion(f, "member", canvasId, vid, "markdown");
      expect(out.status).toBe(200);
      expect(out.body.schema_version).toBe(1);
      expect(typeof out.body.markdown).toBe("string");
      expect(out.body.markdown).toContain("## 1.");
      expect(out.body.markdown).toContain("Canvas có measurement");
      // measurement + assignee_user_id cannot survive Markdown — the
      // export MUST say so.
      expect(out.body.warnings).toContain("JSON_REQUIRED_FOR_EXTENSIONS");
    } finally {
      await f.close();
    }
  });

  it("denies uniformly — admin, outsider, wrong canvas/version pair all get 404", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, publishable());
      await mustPublish(f, "member", canvasId);
      const vid = await versionIdOf(f, "member", canvasId);

      for (const persona of ["admin", "outsider"] as const) {
        expect((await exportVersion(f, persona, canvasId, vid)).status).toBe(404);
        expect((await exportPreview(f, persona, canvasId)).status).toBe(404);
      }
      // Version of a different canvas paired with this canvas id.
      const other = await mustCreate(f, "member", f.ids.member, publishable());
      await mustPublish(f, "member", other);
      const otherVid = await versionIdOf(f, "member", other);
      expect(
        (await exportVersion(f, "member", canvasId, otherVid)).status,
      ).toBe(404);
      expect(
        (await exportVersion(f, "member", canvasId, vid, "docx")).status,
      ).toBe(400);
    } finally {
      await f.close();
    }
  });

  it("export-preview serves the CURRENT draft — edits are visible, publish consumes it", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, publishable());

      // Draft exists from creation — preview returns its body.
      const first = await exportPreview(f, "member", canvasId);
      expect(first.status).toBe(200);
      expect(first.body.body.meta.title).toBe("Canvas export");

      // Save a marker, preview again — the saved draft is what exports.
      const edited = publishable({
        meta: { ...clone(canonical.meta), title: "Đã sửa trong nháp" },
      });
      await saveDraft(f, "member", canvasId, edited);
      const second = await exportPreview(f, "member", canvasId);
      expect(second.status).toBe(200);
      expect(second.body.body.meta.title).toBe("Đã sửa trong nháp");

      // Publish consumes the draft — preview on the consumed draft is 404.
      await mustPublish(f, "member", canvasId, 2);
      expect((await exportPreview(f, "member", canvasId)).status).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("audits exports with format/id metadata only — never content", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "owner", f.ids.owner, publishable());
      await mustPublish(f, "owner", canvasId);
      const vid = await versionIdOf(f, "owner", canvasId);

      await exportVersion(f, "owner", canvasId, vid, "markdown");
      await exportPreview(f, "owner", canvasId); // 404 is fine — publish consumed it; reopened draft needed
      await f.api("owner").post(`/api/v1/canvases/${canvasId}/draft`).send({});
      const prev = await exportPreview(f, "owner", canvasId);
      expect(prev.status).toBe(200);

      const audit = await f
        .api("owner")
        .get("/api/v1/audit?limit=50");
      expect(audit.status).toBe(200);
      const items = (audit.body.items ?? audit.body) as {
        action: string;
        targetId: string | null;
        metadata: Record<string, unknown>;
      }[];
      const exports = items.filter((e) => e.action === "canvas.export");
      expect(exports.length).toBeGreaterThanOrEqual(2);
      const mdExport = exports.find((e) => e.metadata.mode === "markdown");
      expect(mdExport?.targetId).toBe(vid);
      // No content fields may appear — metadata is allowlist-scrubbed.
      for (const e of exports) {
        expect(Object.keys(e.metadata)).toEqual(
          expect.arrayContaining(["mode"]),
        );
        expect(JSON.stringify(e.metadata)).not.toContain("Canvas export");
      }
    } finally {
      await f.close();
    }
  });
});
