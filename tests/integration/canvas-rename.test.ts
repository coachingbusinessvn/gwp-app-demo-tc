import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanvasBody } from "../../shared/canvas/schema.js";
import { fixture, type Persona } from "../helpers/fixture.js";

/**
 * PATCH /api/v1/canvases/:id {name} — rename the canvas record.
 *
 * Same gate as every other canvas mutation (assertWriteIn): active actor →
 * canvas in the actor's company → subject access on the OWNER (self |
 * owner role | manager over the current subtree) → not archived. Denied,
 * missing and foreign ids are the uniform 404 — and that 404 precedes body
 * validation, so a malformed envelope never reveals existence. Archived is
 * 409 CANVAS_ARCHIVED. The rename touches only the record's display name:
 * the shared draft (whose meta.title is user-edited content) keeps its
 * revision. Audit is metadata-only — the field name, never the new name.
 *
 * Seed tree: member → manager → owner, outsider → owner, admin (no reports).
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
type TestResponse = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
};

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as CanvasBody;

function rename(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
  body: unknown,
): Promise<TestResponse> {
  return f
    .api(persona)
    .patch(`/api/v1/canvases/${canvasId}`)
    .send(body as object) as unknown as Promise<TestResponse>;
}

async function mustCreate(
  f: Fixture,
  persona: Persona,
  ownerUserId: string,
  name = "Canvas gốc",
): Promise<string> {
  const res = (await f
    .api(persona)
    .post("/api/v1/canvases")
    .send({
      ownerUserId,
      name,
      body: JSON.parse(JSON.stringify(canonical)),
    })) as unknown as TestResponse;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe("PATCH /api/v1/canvases/:id — rename", () => {
  it("renames the record for the canvas owner; detail and list follow; draft untouched; audited without the name", async () => {
    const f = await fixture({ seeded: true });
    try {
      const id = await mustCreate(f, "member", f.ids.member);
      const before = await f.db("canvas_draft").where({ canvas_id: id }).first();

      const res = await rename(f, "member", id, { name: "  Canvas Q4 — An  " });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.name).toBe("Canvas Q4 — An");
      expect(res.body.ownerUserId).toBe(f.ids.member);

      const detail = (await f
        .api("member")
        .get(`/api/v1/canvases/${id}`)) as unknown as TestResponse;
      expect(detail.body.name).toBe("Canvas Q4 — An");
      const list = (await f
        .api("member")
        .get("/api/v1/canvases")) as unknown as TestResponse;
      expect(
        list.body.items.find((c: { id: string }) => c.id === id).name,
      ).toBe("Canvas Q4 — An");

      // The draft is content with its own CAS — a rename never bumps it.
      const after = await f.db("canvas_draft").where({ canvas_id: id }).first();
      expect(after.revision).toBe(before.revision);

      const audit = await f
        .db("audit_event")
        .where({ action: "canvas.rename", target_id: id })
        .select("actor_id", "target_type", "outcome", "safe_metadata");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_id: f.ids.member,
        target_type: "canvas",
        outcome: "success",
      });
      expect(audit[0].safe_metadata).toEqual({ field: "name" });
      expect(JSON.stringify(audit[0])).not.toContain("Canvas Q4");
    } finally {
      await f.close();
    }
  });

  it("follows the subject policy: manager over subtree and owner allowed; outsider/admin 404; anonymous 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      const id = await mustCreate(f, "member", f.ids.member);
      expect((await rename(f, "manager", id, { name: "Bởi manager" })).status).toBe(200);
      expect((await rename(f, "owner", id, { name: "Bởi owner" })).status).toBe(200);
      for (const p of ["outsider", "admin"] as const) {
        const r = await rename(f, p, id, { name: "Chiếm quyền" });
        expect(r.status, p).toBe(404);
        expect(r.body.code).toBe("NOT_FOUND");
      }
      expect((await rename(f, undefined, id, { name: "x" })).status).toBe(401);
      const row = await f.db("canvas").where({ id }).first();
      expect(row.name).toBe("Bởi owner");
    } finally {
      await f.close();
    }
  });

  it("validates the strict body only after access — denied callers see 404, never 400", async () => {
    const f = await fixture({ seeded: true });
    try {
      const id = await mustCreate(f, "member", f.ids.member);
      for (const bad of [
        {},
        { name: "" },
        { name: "   " },
        { name: "x".repeat(201) },
        { name: 42 },
        { name: "ok", ownerUserId: f.ids.outsider },
      ]) {
        const r = await rename(f, "member", id, bad);
        expect(r.status, JSON.stringify(bad)).toBe(400);
        expect(r.body.code).toBe("INVALID_INPUT");
        expect((await rename(f, "outsider", id, bad)).status).toBe(404);
      }
      // Missing / malformed ids → uniform 404.
      expect(
        (await rename(f, "owner", "00000000-0000-4000-8000-000000000000", { name: "x" })).status,
      ).toBe(404);
      expect((await rename(f, "owner", "not-a-uuid", { name: "x" })).status).toBe(404);
      const row = await f.db("canvas").where({ id }).first();
      expect(row.name).toBe("Canvas gốc");
    } finally {
      await f.close();
    }
  });

  it("refuses to rename an archived canvas with 409 CANVAS_ARCHIVED", async () => {
    const f = await fixture({ seeded: true });
    try {
      const id = await mustCreate(f, "member", f.ids.member);
      const arch = (await f
        .api("member")
        .post(`/api/v1/canvases/${id}/archive`)
        .send({})) as unknown as TestResponse;
      expect(arch.status).toBe(200);
      const r = await rename(f, "member", id, { name: "Sau lưu trữ" });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("CANVAS_ARCHIVED");
      // Outsider still gets the uniform 404 — archive state is not leaked.
      expect((await rename(f, "outsider", id, { name: "x" })).status).toBe(404);
    } finally {
      await f.close();
    }
  });
});
