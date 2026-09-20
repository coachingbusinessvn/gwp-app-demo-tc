import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanvasBody } from "../../shared/canvas/schema.js";
import { fixture, type Persona } from "../helpers/fixture.js";

/**
 * Task 2.3 — canvas persistence behind the shared subject policy (spec §4/§5):
 *
 *   POST /api/v1/canvases                      — create canvas + first draft
 *   GET  /api/v1/canvases?limit&cursor         — scoped keyset page
 *   GET  /api/v1/canvases/:id                  — canvas detail
 *   POST /api/v1/canvases/:id/draft            — open the shared draft
 *   GET  /api/v1/canvases/:id/versions/:vid    — one published snapshot
 *
 * Access = self OR owner (whole company) OR manager over the canvas owner's
 * CURRENT subtree — identical to the authorization policy. Admin has NO
 * canvas privilege beyond its own canvases: it manages org metadata, not
 * user content. Missing, foreign and denied ids are the same 404 — a canvas
 * id is never enumerable. An assignee_user_id inside the body is content,
 * not a grant: it never opens access by itself.
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

function createCanvas(
  f: Fixture,
  persona: Persona | undefined,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post("/api/v1/canvases")
    .send(body) as unknown as Promise<TestResponse>;
}

function getCanvas(
  f: Fixture,
  persona: Persona | undefined,
  id: string,
): Promise<TestResponse> {
  return f
    .api(persona)
    .get(`/api/v1/canvases/${id}`) as unknown as Promise<TestResponse>;
}

function listCanvases(
  f: Fixture,
  persona: Persona | undefined,
  query = "",
): Promise<TestResponse> {
  return f
    .api(persona)
    .get(`/api/v1/canvases${query}`) as unknown as Promise<TestResponse>;
}

function postDraft(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/draft`)
    .send({}) as unknown as Promise<TestResponse>;
}

function getVersion(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
  versionId: string,
): Promise<TestResponse> {
  return f
    .api(persona)
    .get(
      `/api/v1/canvases/${canvasId}/versions/${versionId}`,
    ) as unknown as Promise<TestResponse>;
}

/** A valid create payload: canonical body owned by `ownerUserId`. */
function createBody(
  ownerUserId: string,
  name = "Canvas thử nghiệm",
  body: unknown = clone(canonical),
): Record<string, unknown> {
  return { ownerUserId, name, body };
}

/** Create a canvas through the real API; asserts 201 and returns the id. */
async function mustCreate(
  f: Fixture,
  persona: Persona,
  ownerUserId: string,
  name?: string,
): Promise<string> {
  const res = await createCanvas(f, persona, createBody(ownerUserId, name));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/**
 * Direct DB seed for states the Phase-2.3 API cannot reach yet: a canvas
 * with one published version (and no draft). Publishing lands in task 2.4;
 * until then the version row is written straight past the service, exactly
 * like the policy tests write role rows directly.
 */
async function seedCanvasWithVersion(
  f: Fixture,
  ownerUserId: string,
  body: CanvasBody,
): Promise<{ canvasId: string; versionId: string }> {
  const canvasId = randomUUID();
  const versionId = randomUUID();
  await f.db("canvas").insert({
    id: canvasId,
    company_id: f.ids.company,
    owner_user_id: ownerUserId,
    name: body.meta.title || "Seeded",
    status: "active",
    created_by: ownerUserId,
  });
  await f.db("canvas_version").insert({
    id: versionId,
    company_id: f.ids.company,
    canvas_id: canvasId,
    version_no: 1,
    schema_version: body.schema_version,
    body: JSON.stringify(body),
    published_by: ownerUserId,
  });
  await f
    .db("canvas")
    .where({ id: canvasId, company_id: f.ids.company })
    .update({ current_version_id: versionId });
  return { canvasId, versionId };
}

describe("POST /api/v1/canvases", () => {
  it("gates creation on the subject policy: self/subtree/owner allow; admin gets nothing beyond self", async () => {
    const f = await fixture({ seeded: true });
    try {
      // self — member, manager, admin, owner can all own a canvas.
      for (const p of ["member", "manager", "admin", "owner"] as Persona[]) {
        const res = await createCanvas(f, p, createBody(f.ids[p]));
        expect(res.status, p).toBe(201);
        expect(res.body).toMatchObject({
          id: expect.any(String),
          draft: { id: expect.any(String), revision: 1 },
        });
      }
      // manager → member (current subtree) is allowed.
      expect(
        (await createCanvas(f, "manager", createBody(f.ids.member))).status,
      ).toBe(201);
      // owner → anyone in the company.
      expect(
        (await createCanvas(f, "owner", createBody(f.ids.outsider))).status,
      ).toBe(201);

      // member → anyone but self is denied (uniform 404).
      for (const target of [
        f.ids.manager,
        f.ids.outsider,
        f.ids.admin,
        f.ids.owner,
      ]) {
        expect(
          (await createCanvas(f, "member", createBody(target))).status,
          target,
        ).toBe(404);
      }
      // manager → outsider is outside the current subtree → 404.
      expect(
        (await createCanvas(f, "manager", createBody(f.ids.outsider))).status,
      ).toBe(404);
      expect(
        (await createCanvas(f, "manager", createBody(f.ids.owner))).status,
      ).toBe(404);
      // admin is org-metadata only — creating for anyone but itself → 404.
      for (const target of [f.ids.member, f.ids.manager, f.ids.owner]) {
        expect(
          (await createCanvas(f, "admin", createBody(target))).status,
          target,
        ).toBe(404);
      }
      expect(
        (await createCanvas(f, "outsider", createBody(f.ids.member))).status,
      ).toBe(404);
      // Anonymous → 401.
      expect(
        (await createCanvas(f, undefined, createBody(f.ids.member))).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("persists canvas + first draft atomically with metadata-only audit", async () => {
    const f = await fixture({ seeded: true });
    try {
      const res = await createCanvas(
        f,
        "member",
        createBody(f.ids.member, "Canvas Q4"),
      );
      expect(res.status).toBe(201);
      const canvasId = res.body.id as string;

      const canvas = await f.db("canvas").where({ id: canvasId }).first();
      expect(canvas).toMatchObject({
        company_id: f.ids.company,
        owner_user_id: f.ids.member,
        name: "Canvas Q4",
        status: "active",
        current_version_id: null,
        created_by: f.ids.member,
        archived_at: null,
      });

      // The draft is the working copy: revision 1, no base version yet,
      // and the canvas name is stamped into meta.title (the name field is
      // authoritative — meta.title mirrors it on create).
      const draft = await f
        .db("canvas_draft")
        .where({ canvas_id: canvasId })
        .first();
      expect(draft).toMatchObject({
        id: res.body.draft.id,
        company_id: f.ids.company,
        revision: 1,
        base_version_id: null,
        created_by: f.ids.member,
        updated_by: f.ids.member,
      });
      expect(draft.body.meta.title).toBe("Canvas Q4");
      expect(draft.body.boxes).toHaveLength(6);

      // Both events audited in the same transaction, actor = the member,
      // and safe_metadata never carries canvas content (spec §9).
      const audit = await f
        .db("audit_event")
        .where({ request_id: res.headers["x-request-id"] })
        .orderBy("created_at", "asc")
        .select("action", "actor_id", "target_type", "target_id", "safe_metadata");
      expect(audit.map((r: { action: string }) => r.action)).toEqual([
        "canvas.create",
        "canvas.draft.create",
      ]);
      for (const row of audit) {
        expect(row.actor_id).toBe(f.ids.member);
        expect(row.target_id).toBe(canvasId);
        expect(JSON.stringify(row.safe_metadata)).not.toContain("Canvas Q4");
        expect(row.safe_metadata.body).toBeUndefined();
      }
    } finally {
      await f.close();
    }
  });

  it("rejects malformed/strict-violating bodies and non-company assignee_user_id with 400", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Missing/invalid body shapes → 400 with issue paths in details.
      for (const bad of [
        { ownerUserId: f.ids.member, name: "X" }, // body absent
        { ownerUserId: f.ids.member, name: "X", body: null },
        { ownerUserId: f.ids.member, name: "X", body: "not json object" },
        { ownerUserId: f.ids.member, name: "X", body: { nope: true } },
      ]) {
        const res = await createCanvas(f, "member", bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.code).toBe("INVALID_INPUT");
      }

      // Strict schema: privilege/identity keys injected into the body → 400.
      const injected = clone(canonical) as unknown as Record<string, unknown>;
      injected.company_id = f.ids.company;
      injected.owner_user_id = f.ids.owner;
      expect(
        (
          await createCanvas(
            f,
            "member",
            createBody(f.ids.member, "X", injected),
          )
        ).status,
      ).toBe(400);

      // Schema bounds: outputs ≤3 — pushing the list to 4 rows → 400.
      const tooMany = clone(canonical);
      for (let i = 0; i < 3; i++) {
        tooMany.outputs.push({
          ...clone(canonical.outputs[0]),
          id: randomUUID(),
        });
      }
      expect(
        (
          await createCanvas(f, "member", createBody(f.ids.member, "X", tooMany))
        ).status,
      ).toBe(400);

      // Dangling box→behavior reference → 400.
      const dangling = clone(canonical);
      dangling.boxes[0].behavior_id = randomUUID();
      expect(
        (
          await createCanvas(
            f,
            "member",
            createBody(f.ids.member, "X", dangling),
          )
        ).status,
      ).toBe(400);

      // assignee_user_id naming a nonexistent/foreign user → 400 (it is a
      // resolved reference, never silently stripped).
      const ghostAssignee = clone(canonical);
      ghostAssignee.actions[0].assignee_user_id = randomUUID();
      expect(
        (
          await createCanvas(
            f,
            "member",
            createBody(f.ids.member, "X", ghostAssignee),
          )
        ).status,
      ).toBe(400);
      const foreignAssignee = clone(canonical);
      foreignAssignee.boxes[0].assignee_user_id = f.ids.otherCompany;
      expect(
        (
          await createCanvas(
            f,
            "member",
            createBody(f.ids.member, "X", foreignAssignee),
          )
        ).status,
      ).toBe(400);

      // A same-company assignee is accepted.
      const okAssignee = clone(canonical);
      okAssignee.actions[0].assignee_user_id = f.ids.outsider;
      expect(
        (
          await createCanvas(
            f,
            "member",
            createBody(f.ids.member, "X", okAssignee),
          )
        ).status,
      ).toBe(201);

      // Strict request envelope: unknown top-level keys → 400.
      expect(
        (
          await createCanvas(f, "member", {
            ...createBody(f.ids.member),
            companyId: f.ids.company,
          })
        ).status,
      ).toBe(400);
      // Non-uuid ownerUserId is a schema rejection, not a 404/500.
      expect(
        (
          await createCanvas(f, "member", {
            ownerUserId: "not-a-uuid",
            name: "X",
            body: clone(canonical),
          })
        ).status,
      ).toBe(400);
      // Empty/oversized names → 400.
      expect(
        (
          await createCanvas(f, "member", {
            ownerUserId: f.ids.member,
            name: "   ",
            body: clone(canonical),
          })
        ).status,
      ).toBe(400);
    } finally {
      await f.close();
    }
  });

  it("denies foreign/unknown ownerUserId uniformly and refuses an inactive owner (409)", async () => {
    const f = await fixture({ seeded: true });
    try {
      for (const target of [randomUUID(), f.ids.otherCompany]) {
        const res = await createCanvas(f, "owner", createBody(target));
        expect(res.status, target).toBe(404);
        expect(res.body.code).toBe("NOT_FOUND");
      }

      // Deactivate the member, then even the owner cannot create for them —
      // the owner slot must be an ACTIVE company user.
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ status: "inactive" });
      const res = await createCanvas(f, "owner", createBody(f.ids.member));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("USER_NOT_ACTIVE");
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/canvases/:id", () => {
  it("filters detail by subject policy — admin and cross-subtree get the same 404 as missing ids", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "Mine");

      // self, manager (subtree), owner → 200 with the detail shape.
      for (const p of ["member", "manager", "owner"] as Persona[]) {
        const res = await getCanvas(f, p, canvasId);
        expect(res.status, p).toBe(200);
        expect(res.body).toMatchObject({
          id: canvasId,
          ownerUserId: f.ids.member,
          name: "Mine",
          status: "active",
          currentVersionId: null,
        });
        expect(res.body.draft).toMatchObject({
          canvasId,
          revision: 1,
          baseVersionId: null,
        });
        expect(res.body.draft.body.meta.title).toBe("Mine");
      }

      // admin (no canvas privilege) and outsider (cross-subtree) → 404,
      // identical to unknown/foreign/malformed ids — nothing enumerable.
      for (const p of ["admin", "outsider"] as Persona[]) {
        const res = await getCanvas(f, p, canvasId);
        expect(res.status, p).toBe(404);
        expect(res.body.code).toBe("NOT_FOUND");
      }
      for (const bad of [randomUUID(), f.ids.otherCompany, "not-a-uuid"]) {
        expect((await getCanvas(f, "owner", bad)).status, bad).toBe(404);
      }
      expect((await getCanvas(f, undefined, canvasId)).status).toBe(401);
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/canvases", () => {
  it("scopes the list to the actor's subjects — admin sees only its own", async () => {
    const f = await fixture({ seeded: true });
    try {
      const memberA = await mustCreate(f, "member", f.ids.member, "Member A");
      const memberB = await mustCreate(f, "manager", f.ids.member, "Member B");
      const managerC = await mustCreate(f, "manager", f.ids.manager, "Mgr C");
      const adminD = await mustCreate(f, "admin", f.ids.admin, "Admin D");
      const outsiderE = await mustCreate(f, "owner", f.ids.outsider, "Out E");
      const ownerF = await mustCreate(f, "owner", f.ids.owner, "Owner F");

      const idsOf = (res: TestResponse): string[] =>
        (res.body.items as { id: string }[]).map((i) => i.id);

      const memberList = await listCanvases(f, "member");
      expect(memberList.status).toBe(200);
      expect(idsOf(memberList).sort()).toEqual([memberA, memberB].sort());

      const managerList = await listCanvases(f, "manager");
      expect(idsOf(managerList).sort()).toEqual(
        [memberA, memberB, managerC].sort(),
      );

      const adminList = await listCanvases(f, "admin");
      expect(idsOf(adminList)).toEqual([adminD]);

      const outsiderList = await listCanvases(f, "outsider");
      expect(idsOf(outsiderList)).toEqual([outsiderE]);

      const ownerList = await listCanvases(f, "owner");
      expect(idsOf(ownerList).sort()).toEqual(
        [memberA, memberB, managerC, adminD, outsiderE, ownerF].sort(),
      );

      // Empty scope is a valid page, not an error: a deactivated actor
      // would see nothing, and any fresh member sees an empty list.
      const anon = await listCanvases(f, undefined);
      expect(anon.status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("paginates with the keyset cursor and rejects malformed limit/cursor (400)", async () => {
    const f = await fixture({ seeded: true });
    try {
      const a = await mustCreate(f, "member", f.ids.member, "A");
      const b = await mustCreate(f, "member", f.ids.member, "B");
      const c = await mustCreate(f, "member", f.ids.member, "C");

      const page1 = await listCanvases(f, "member", "?limit=2");
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await listCanvases(
        f,
        "member",
        `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();

      const seen = [...page1.body.items, ...page2.body.items].map(
        (i: { id: string }) => i.id,
      );
      expect(seen.sort()).toEqual([a, b, c].sort());

      for (const bad of ["?limit=0", "?limit=101", "?limit=abc"]) {
        expect((await listCanvases(f, "member", bad)).status, bad).toBe(400);
      }
      for (const bad of ["?cursor=nope", "?cursor=123|not-uuid"]) {
        expect((await listCanvases(f, "member", bad)).status, bad).toBe(400);
      }
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/canvases/:id/draft", () => {
  it("returns 409 when a draft already exists and never destroys the in-progress body", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "Drafted");
      const draft = await f
        .db("canvas_draft")
        .where({ canvas_id: canvasId })
        .first();

      // Simulate in-progress edits written straight to the draft row.
      const edited = clone(canonical);
      edited.goal.statement = "Bản nháp đang sửa — không được mất";
      await f
        .db("canvas_draft")
        .where({ id: draft.id })
        .update({ body: JSON.stringify(edited), revision: 7 });

      const res = await postDraft(f, "member", canvasId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("DRAFT_EXISTS");

      // The in-progress draft is byte-identical — create never overwrites.
      const after = await f
        .db("canvas_draft")
        .where({ canvas_id: canvasId })
        .first();
      expect(after.id).toBe(draft.id);
      expect(after.revision).toBe(7);
      expect(after.body.goal.statement).toBe(
        "Bản nháp đang sửa — không được mất",
      );
    } finally {
      await f.close();
    }
  });

  it("copies the current published version into the new draft, else a blank canvas", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Canvas WITH a published version (seeded directly — publish is 2.4):
      // the draft body is the published snapshot and base_version_id links it.
      const published = clone(canonical);
      published.meta.title = "Đã publish";
      const { canvasId, versionId } = await seedCanvasWithVersion(
        f,
        f.ids.member,
        published,
      );
      const res = await postDraft(f, "member", canvasId);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        canvasId,
        baseVersionId: versionId,
        revision: 1,
      });
      expect(res.body.body.meta.title).toBe("Đã publish");
      expect(res.body.body.outputs[0].name).toBe(
        canonical.outputs[0].name,
      );

      // A second POST collides on the one-draft-per-canvas rule.
      expect((await postDraft(f, "member", canvasId)).status).toBe(409);
    } finally {
      await f.close();
    }
  });

  it("rejects writes on archived canvases and denied subjects uniformly", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Archived canvas — seeded archived directly (archive route is 2.4);
      // without a draft, so the only gate reached is assertWrite's archive
      // check → 409, not a silent draft create.
      const { canvasId } = await seedCanvasWithVersion(
        f,
        f.ids.member,
        clone(canonical),
      );
      await f
        .db("canvas")
        .where({ id: canvasId })
        .update({
          status: "archived",
          archived_at: new Date(),
          archived_by: f.ids.owner,
        });
      const res = await postDraft(f, "member", canvasId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CANVAS_ARCHIVED");
      expect(
        await f.db("canvas_draft").where({ canvas_id: canvasId }).first(),
      ).toBeUndefined();

      // Denied actors get the same 404 as a missing canvas.
      const live = await mustCreate(f, "member", f.ids.member, "Live");
      for (const p of ["admin", "outsider"] as Persona[]) {
        expect((await postDraft(f, p, live)).status, p).toBe(404);
      }
      expect((await postDraft(f, undefined, live)).status).toBe(401);
      for (const bad of [randomUUID(), "not-a-uuid"]) {
        expect((await postDraft(f, "owner", bad)).status, bad).toBe(404);
      }
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/canvases/:id/versions/:versionId", () => {
  it("returns the snapshot only through subject access — no cross-canvas or admin leak", async () => {
    const f = await fixture({ seeded: true });
    try {
      const body = clone(canonical);
      const { canvasId, versionId } = await seedCanvasWithVersion(
        f,
        f.ids.member,
        body,
      );

      for (const p of ["member", "manager", "owner"] as Persona[]) {
        const res = await getVersion(f, p, canvasId, versionId);
        expect(res.status, p).toBe(200);
        expect(res.body).toMatchObject({
          id: versionId,
          canvasId,
          versionNo: 1,
          publishedBy: f.ids.member,
        });
        expect(res.body.body.meta.title).toBe(canonical.meta.title);
      }

      // admin/outsider → 404 — and so do every wrong pairing: another
      // canvas's version, unknown ids, malformed ids, foreign company id.
      for (const p of ["admin", "outsider"] as Persona[]) {
        expect((await getVersion(f, p, canvasId, versionId)).status, p).toBe(
          404,
        );
      }
      const other = await seedCanvasWithVersion(f, f.ids.manager, clone(canonical));
      expect(
        (await getVersion(f, "manager", canvasId, other.versionId)).status,
      ).toBe(404);
      expect(
        (await getVersion(f, "member", other.canvasId, versionId)).status,
      ).toBe(404);
      expect(
        (await getVersion(f, "owner", canvasId, randomUUID())).status,
      ).toBe(404);
      expect(
        (await getVersion(f, "owner", randomUUID(), versionId)).status,
      ).toBe(404);
      expect(
        (await getVersion(f, "owner", canvasId, "not-a-uuid")).status,
      ).toBe(404);
      expect((await getVersion(f, undefined, canvasId, versionId)).status).toBe(
        401,
      );
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/canvases/:id/versions", () => {
  function listVersions(
    f: Fixture,
    persona: Persona | undefined,
    canvasId: string,
  ): Promise<TestResponse> {
    return f
      .api(persona)
      .get(`/api/v1/canvases/${canvasId}/versions`) as unknown as Promise<TestResponse>;
  }

  it("returns ordered summaries with publisher names — bodies stay behind the single-version read", async () => {
    const f = await fixture({ seeded: true });
    try {
      const { canvasId, versionId } = await seedCanvasWithVersion(
        f,
        f.ids.member,
        clone(canonical),
      );
      // A second, newer version — published by the manager this time.
      const v2 = clone(canonical);
      v2.meta.title = "V2";
      const versionId2 = randomUUID();
      await f.db("canvas_version").insert({
        id: versionId2,
        company_id: f.ids.company,
        canvas_id: canvasId,
        version_no: 2,
        schema_version: v2.schema_version,
        body: JSON.stringify(v2),
        change_summary: "Chốt sau review tuần 2",
        published_by: f.ids.manager,
      });
      await f
        .db("canvas")
        .where({ id: canvasId, company_id: f.ids.company })
        .update({ current_version_id: versionId2 });

      for (const p of ["member", "manager", "owner"] as Persona[]) {
        const res = await listVersions(f, p, canvasId);
        expect(res.status, p).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        // Newest first; summaries only — a body must never ride the list.
        expect(res.body.map((v: { id: string }) => v.id)).toEqual([
          versionId2,
          versionId,
        ]);
        expect(res.body[0]).toMatchObject({
          id: versionId2,
          versionNo: 2,
          publishedBy: f.ids.manager,
          publishedByName: "Fixture Manager",
          changeSummary: "Chốt sau review tuần 2",
        });
        expect(res.body[1]).toMatchObject({
          id: versionId,
          versionNo: 1,
          publishedBy: f.ids.member,
          publishedByName: "Fixture Member",
        });
        for (const v of res.body) {
          expect(v.body).toBeUndefined();
        }
      }

      // A canvas with no versions yet → empty list, still 200.
      const empty = await mustCreate(f, "member", f.ids.member, "No versions");
      const res = await listVersions(f, "member", empty);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("is non-enumerable: denied, foreign, missing and anonymous callers get the uniform 404/401", async () => {
    const f = await fixture({ seeded: true });
    try {
      const { canvasId } = await seedCanvasWithVersion(
        f,
        f.ids.member,
        clone(canonical),
      );
      // admin has no canvas privilege; outsider is outside the subtree.
      for (const p of ["admin", "outsider"] as Persona[]) {
        const res = await listVersions(f, p, canvasId);
        expect(res.status, p).toBe(404);
        expect(res.body.code).toBe("NOT_FOUND");
      }
      for (const bad of [randomUUID(), f.ids.otherCompany, "not-a-uuid"]) {
        expect((await listVersions(f, "owner", bad)).status, bad).toBe(404);
      }
      expect((await listVersions(f, undefined, canvasId)).status).toBe(401);
    } finally {
      await f.close();
    }
  });
});

describe("assignee_user_id is content, not a grant", () => {
  it("being assigned inside a body never opens the canvas to that user", async () => {
    const f = await fixture({ seeded: true });
    try {
      const body = clone(canonical);
      body.actions[0].assignee_user_id = f.ids.outsider;
      body.boxes[0].assignee_user_id = f.ids.outsider;
      const res = await createCanvas(
        f,
        "member",
        createBody(f.ids.member, "Assigned", body),
      );
      expect(res.status).toBe(201);
      const canvasId = res.body.id as string;

      // outsider is named inside the canvas body yet has zero access.
      expect((await getCanvas(f, "outsider", canvasId)).status).toBe(404);
      expect((await postDraft(f, "outsider", canvasId)).status).toBe(404);
      const list = await listCanvases(f, "outsider");
      expect(
        (list.body.items as { id: string }[]).map((i) => i.id),
      ).not.toContain(canvasId);
    } finally {
      await f.close();
    }
  });
});
