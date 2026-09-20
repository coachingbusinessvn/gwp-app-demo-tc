import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanvasBody } from "../../shared/canvas/schema.js";
import { fixture, type Persona } from "../helpers/fixture.js";

/**
 * Task 2.4 — conflict-safe draft editing, idempotent publish and the canvas
 * lifecycle ops (spec §5.2/§9):
 *
 *   PUT  /api/v1/canvases/:id/draft                    — CAS save
 *   POST /api/v1/canvases/:id/publish                  — idempotent publish
 *   POST /api/v1/canvases/:id/versions/:vid/restore    — restore into draft
 *   POST /api/v1/canvases/:id/archive                  — archive (write-off)
 *   POST /api/v1/canvases/:id/transfer                 — owner-only transfer
 *
 * Every concurrency invariant is proven on real PostgreSQL with Promise.all
 * races: the company row lock serializes same-company mutations, the draft
 * UPDATE carries a revision CAS predicate, and publish is idempotent through
 * a (scope, key) write_receipt bound to a request hash. Audit rows are
 * metadata-only and commit inside the same transaction.
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

function putDraft(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .put(`/api/v1/canvases/${canvasId}/draft`)
    .send(body) as unknown as Promise<TestResponse>;
}

function publish(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/publish`)
    .send(body) as unknown as Promise<TestResponse>;
}

function restore(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
  versionId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/versions/${versionId}/restore`)
    .send(body) as unknown as Promise<TestResponse>;
}

function archive(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/archive`)
    .send({}) as unknown as Promise<TestResponse>;
}

function transfer(
  f: Fixture,
  persona: Persona | undefined,
  canvasId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post(`/api/v1/canvases/${canvasId}/transfer`)
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

/** A publishable draft body: canonical fixture with a distinct title. */
function publishableBody(title: string): CanvasBody {
  const body = clone(canonical);
  body.meta.title = title;
  return body;
}

/** Create a canvas through the real API; asserts 201 and returns its id. */
async function mustCreate(
  f: Fixture,
  persona: Persona,
  ownerUserId: string,
  name = "Canvas 2.4",
  body: unknown = publishableBody(name),
): Promise<string> {
  const res = await createCanvas(f, persona, { ownerUserId, name, body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** The live draft row for a canvas straight from the DB. */
async function draftOf(f: Fixture, canvasId: string) {
  return f.db("canvas_draft").where({ canvas_id: canvasId }).first();
}

describe("PUT /api/v1/canvases/:id/draft — CAS saves", () => {
  it("serializes two concurrent saves on the same revision — exactly one wins", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      const draft = await draftOf(f, canvasId);
      expect(draft.revision).toBe(1);

      const editA = publishableBody("Edit A");
      const editB = publishableBody("Edit B");
      const save = {
        expectedRevision: 1,
        baseVersionId: null,
      };
      const [a, b] = await Promise.all([
        putDraft(f, "member", canvasId, { ...save, body: editA }),
        putDraft(f, "member", canvasId, { ...save, body: editB }),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe("DRAFT_CONFLICT");
      const winner = a.status === 200 ? a : b;
      expect(winner.body.revision).toBe(2);

      // Exactly one write landed; the revision moved once.
      const after = await draftOf(f, canvasId);
      expect(after.revision).toBe(2);
      expect(after.updated_by).toBe(f.ids.member);
    } finally {
      await f.close();
    }
  });

  it("rejects a stale expectedRevision and a stale baseVersionId with 409", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);

      const ok = await putDraft(f, "member", canvasId, {
        expectedRevision: 1,
        baseVersionId: null,
        body: publishableBody("Second pass"),
      });
      expect(ok.status).toBe(200);
      expect(ok.body.revision).toBe(2);
      expect(ok.body.body.meta.title).toBe("Second pass");

      // Replaying the old revision → conflict, nothing written.
      const staleRev = await putDraft(f, "member", canvasId, {
        expectedRevision: 1,
        baseVersionId: null,
        body: publishableBody("Sneaky overwrite"),
      });
      expect(staleRev.status).toBe(409);
      expect(staleRev.body.code).toBe("DRAFT_CONFLICT");

      // Right revision but a base the draft never had → conflict too.
      const staleBase = await putDraft(f, "member", canvasId, {
        expectedRevision: 2,
        baseVersionId: randomUUID(),
        body: publishableBody("Wrong base"),
      });
      expect(staleBase.status).toBe(409);
      expect(staleBase.body.code).toBe("DRAFT_CONFLICT");

      // The correct pair still lands — the conflicts wrote nothing.
      const still = await putDraft(f, "member", canvasId, {
        expectedRevision: 2,
        baseVersionId: null,
        body: publishableBody("Third pass"),
      });
      expect(still.status).toBe(200);
      expect((await draftOf(f, canvasId)).revision).toBe(3);
    } finally {
      await f.close();
    }
  });

  it("validates the body draft-mode and audits the save metadata-only", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);

      // Schema-broken body → 400 with issue paths.
      const bad = await putDraft(f, "member", canvasId, {
        expectedRevision: 1,
        baseVersionId: null,
        body: { nope: true },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("INVALID_INPUT");

      // Draft-valid but publish-incomplete content is fine on save.
      const draftOk = clone(canonical);
      draftOk.goal.statement = "";
      draftOk.boxes[0].behavior_id = null;
      const res = await putDraft(f, "member", canvasId, {
        expectedRevision: 1,
        baseVersionId: null,
        body: draftOk,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const audit = await f
        .db("audit_event")
        .where({ action: "canvas.draft.save" })
        .select("actor_id", "target_id", "safe_metadata");
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_id).toBe(f.ids.member);
      expect(audit[0].target_id).toBe(canvasId);
      expect(audit[0].safe_metadata.version).toBe(2);
      expect(audit[0].safe_metadata.body).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("404s when there is no draft to save and on denied/missing canvases", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      // Publish deletes the draft — a later save has nothing to CAS.
      const pub = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: `pub-${randomUUID()}`,
      });
      expect(pub.status).toBe(200);

      const noDraft = await putDraft(f, "member", canvasId, {
        expectedRevision: 1,
        baseVersionId: pub.body.versionId,
        body: publishableBody("Too late"),
      });
      expect(noDraft.status).toBe(404);

      const other = await mustCreate(f, "member", f.ids.member);
      for (const p of ["admin", "outsider"] as Persona[]) {
        expect(
          (
            await putDraft(f, p, other, {
              expectedRevision: 1,
              baseVersionId: null,
              body: publishableBody("Denied"),
            })
          ).status,
          p,
        ).toBe(404);
      }
      expect(
        (
          await putDraft(f, undefined, other, {
            expectedRevision: 1,
            baseVersionId: null,
            body: publishableBody("Anon"),
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await putDraft(f, "owner", randomUUID(), {
            expectedRevision: 1,
            baseVersionId: null,
            body: publishableBody("Ghost"),
          })
        ).status,
      ).toBe(404);
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/canvases/:id/publish", () => {
  it("publishes atomically — immutable version, pointer bumped, draft deleted, audited", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "V1");
      const res = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: `pub-${randomUUID()}`,
        changeSummary: "Chốt phiên bản đầu",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        versionId: expect.any(String),
        versionNo: 1,
      });
      const versionId = res.body.versionId as string;

      const version = await f
        .db("canvas_version")
        .where({ id: versionId })
        .first();
      expect(version).toMatchObject({
        company_id: f.ids.company,
        canvas_id: canvasId,
        version_no: 1,
        published_by: f.ids.member,
        change_summary: "Chốt phiên bản đầu",
      });
      expect(version.body.meta.title).toBe("V1");

      const canvas = await f.db("canvas").where({ id: canvasId }).first();
      expect(canvas.current_version_id).toBe(versionId);
      expect(await draftOf(f, canvasId)).toBeUndefined();

      const receipt = await f
        .db("write_receipt")
        .where({ result_id: versionId })
        .first();
      expect(receipt).toBeDefined();

      const audit = await f
        .db("audit_event")
        .where({ action: "canvas.publish" })
        .select("actor_id", "target_id", "safe_metadata");
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_id).toBe(f.ids.member);
      expect(audit[0].target_id).toBe(canvasId);
      expect(audit[0].safe_metadata.version).toBe(1);
      expect(audit[0].safe_metadata.body).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("replays a retry with the same idempotencyKey — no second version row", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      const key = `pub-${randomUUID()}`;
      const payload = { expectedRevision: 1, idempotencyKey: key };

      // A racing pair on the same key: both must return the SAME version.
      const [a, b] = await Promise.all([
        publish(f, "member", canvasId, payload),
        publish(f, "member", canvasId, payload),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.versionId).toBe(b.body.versionId);
      expect(a.body.versionNo).toBe(1);

      // A later sequential retry replays the stored result too.
      const retry = await publish(f, "member", canvasId, payload);
      expect(retry.status).toBe(200);
      expect(retry.body.versionId).toBe(a.body.versionId);
      expect(retry.body.versionNo).toBe(1);

      const versions = await f
        .db("canvas_version")
        .where({ canvas_id: canvasId });
      expect(versions).toHaveLength(1);
      const receipts = await f
        .db("write_receipt")
        .where({ result_id: a.body.versionId });
      expect(receipts).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("rejects the same key with a different request body — 409, no write", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      const key = `pub-${randomUUID()}`;
      const first = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: key,
        changeSummary: "v1",
      });
      expect(first.status).toBe(200);

      const conflict = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: key,
        changeSummary: "different payload",
      });
      expect(conflict.status).toBe(409);

      const versions = await f
        .db("canvas_version")
        .where({ canvas_id: canvasId });
      expect(versions).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("checks permission BEFORE the receipt — a deactivated actor's retry is denied", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      const payload = {
        expectedRevision: 1,
        idempotencyKey: `pub-${randomUUID()}`,
      };
      const first = await publish(f, "member", canvasId, payload);
      expect(first.status).toBe(200);

      // Revocation lands between the original and the retry.
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ status: "inactive" });

      const retry = await publish(f, "member", canvasId, payload);
      // authenticate() re-reads the user per request → 401; a mid-flight
      // revocation past authenticate → 403/404. Never a replayed 200.
      expect([401, 403, 404]).toContain(retry.status);
      expect(
        await f.db("canvas_version").where({ canvas_id: canvasId }),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("rejects publish-incomplete drafts with 400 + issue paths, and stale revisions with 409", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Draft-valid but publish-incomplete: blank goal + unconfirmed box.
      const incomplete = clone(canonical);
      incomplete.goal.statement = "";
      incomplete.kr.metric = "";
      incomplete.boxes[0].behavior_id = null;
      const canvasId = await mustCreate(
        f,
        "member",
        f.ids.member,
        "Chưa đủ",
        incomplete,
      );

      const bad = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: `pub-${randomUUID()}`,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("INVALID_INPUT");
      const fields = bad.body.details.fields as string[];
      expect(fields).toEqual(
        expect.arrayContaining([
          "goal.statement",
          "kr.metric",
          "boxes.0.behavior_id",
        ]),
      );

      // Failed validation wrote nothing — no version, no receipt, draft alive.
      expect(
        await f.db("canvas_version").where({ canvas_id: canvasId }),
      ).toHaveLength(0);
      expect((await draftOf(f, canvasId)).revision).toBe(1);

      const stale = await publish(f, "member", canvasId, {
        expectedRevision: 99,
        idempotencyKey: `pub-${randomUUID()}`,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("DRAFT_CONFLICT");

      // Publishing a canvas with no draft at all → 404.
      const seeded = randomUUID();
      await f.db("canvas").insert({
        id: seeded,
        company_id: f.ids.company,
        owner_user_id: f.ids.member,
        name: "No draft",
        status: "active",
        created_by: f.ids.member,
      });
      const none = await publish(f, "member", seeded, {
        expectedRevision: 1,
        idempotencyKey: `pub-${randomUUID()}`,
      });
      expect(none.status).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("assigns monotonic version numbers across successive publishes", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "One");
      const v1 = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: `k1-${randomUUID()}`,
      });
      expect(v1.body.versionNo).toBe(1);

      // Reopen the draft (copies v1), save an edit, publish again → v2.
      const reopened = await f
        .api("member")
        .post(`/api/v1/canvases/${canvasId}/draft`)
        .send({});
      expect(reopened.status).toBe(201);
      const saved = await putDraft(f, "member", canvasId, {
        expectedRevision: reopened.body.revision,
        baseVersionId: v1.body.versionId,
        body: publishableBody("Two"),
      });
      expect(saved.status).toBe(200);

      const v2 = await publish(f, "member", canvasId, {
        expectedRevision: saved.body.revision,
        idempotencyKey: `k2-${randomUUID()}`,
      });
      expect(v2.status).toBe(200);
      expect(v2.body.versionNo).toBe(2);
      expect(v2.body.versionId).not.toBe(v1.body.versionId);

      const rows = await f
        .db("canvas_version")
        .where({ canvas_id: canvasId })
        .orderBy("version_no", "asc");
      expect(rows.map((r: { version_no: number }) => r.version_no)).toEqual([
        1, 2,
      ]);
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/canvases/:id/versions/:versionId/restore", () => {
  it("copies the version body into a new draft and never touches history", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "V1");
      const v1 = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: `k1-${randomUUID()}`,
      });
      const versionId = v1.body.versionId as string;
      const before = await f
        .db("canvas_version")
        .where({ id: versionId })
        .first();

      // Publish a second version so restore has to reach BACK for the body.
      await f
        .api("member")
        .post(`/api/v1/canvases/${canvasId}/draft`)
        .send({});
      const saved = await putDraft(f, "member", canvasId, {
        expectedRevision: 1,
        baseVersionId: versionId,
        body: publishableBody("V2"),
      });
      const v2 = await publish(f, "member", canvasId, {
        expectedRevision: saved.body.revision,
        idempotencyKey: `k2-${randomUUID()}`,
      });
      expect(v2.body.versionNo).toBe(2);

      // No live draft: restore v1 → new draft whose body is v1's, based on
      // the CURRENT head (v2) — history rows are never rewritten.
      const res = await restore(f, "member", canvasId, versionId, {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        canvasId,
        revision: 1,
        baseVersionId: v2.body.versionId,
      });
      expect(res.body.body.meta.title).toBe("V1");

      const after = await f
        .db("canvas_version")
        .where({ id: versionId })
        .first();
      expect(after).toEqual(before);
      expect(
        await f.db("canvas_version").where({ canvas_id: canvasId }),
      ).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it("never silently discards a live draft — requires expectedRevision + confirm", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "Keep");
      const v1 = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: `k1-${randomUUID()}`,
      });
      const versionId = v1.body.versionId as string;

      // Reopen + edit so the live draft carries unsaved work.
      await f
        .api("member")
        .post(`/api/v1/canvases/${canvasId}/draft`)
        .send({});
      const saved = await putDraft(f, "member", canvasId, {
        expectedRevision: 1,
        baseVersionId: versionId,
        body: publishableBody("Work in progress"),
      });
      expect(saved.status).toBe(200);
      const liveRev = saved.body.revision as number;

      // No confirmation → 409, draft untouched.
      for (const attempt of [
        {},
        { confirm: true },
        { expectedRevision: liveRev },
        { expectedRevision: 999, confirm: true },
      ]) {
        const res = await restore(f, "member", canvasId, versionId, attempt);
        expect(res.status, JSON.stringify(attempt)).toBe(409);
        expect(res.body.code).toBe("DRAFT_CONFLICT");
      }
      const stillThere = await draftOf(f, canvasId);
      expect(stillThere.revision).toBe(liveRev);
      expect(stillThere.body.meta.title).toBe("Work in progress");

      // Explicit confirm + matching revision → overwrite proceeds, revision
      // bumps, base stays pinned to the current head.
      const ok = await restore(f, "member", canvasId, versionId, {
        expectedRevision: liveRev,
        confirm: true,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.revision).toBe(liveRev + 1);
      expect(ok.body.baseVersionId).toBe(versionId);
      expect(ok.body.body.meta.title).toBe("Keep");
    } finally {
      await f.close();
    }
  });

  it("is gated like every write — denied 404, archived 409, unknown version 404", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "R");
      const v1 = await publish(f, "member", canvasId, {
        expectedRevision: 1,
        idempotencyKey: `k1-${randomUUID()}`,
      });
      const versionId = v1.body.versionId as string;

      for (const p of ["admin", "outsider"] as Persona[]) {
        expect(
          (await restore(f, p, canvasId, versionId, {})).status,
          p,
        ).toBe(404);
      }
      expect(
        (await restore(f, "member", canvasId, randomUUID(), {})).status,
      ).toBe(404);
      expect(
        (await restore(f, "member", randomUUID(), versionId, {})).status,
      ).toBe(404);

      expect((await archive(f, "member", canvasId)).status).toBe(200);
      const res = await restore(f, "member", canvasId, versionId, {});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("CANVAS_ARCHIVED");
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/canvases/:id/archive", () => {
  it("archives the canvas and blocks every subsequent write", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "Old");
      const res = await archive(f, "member", canvasId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const row = await f.db("canvas").where({ id: canvasId }).first();
      expect(row.status).toBe("archived");
      expect(row.archived_by).toBe(f.ids.member);
      expect(row.archived_at).not.toBeNull();

      // Reads still work — archive is a write gate, not a tombstone.
      expect((await getCanvas(f, "member", canvasId)).status).toBe(200);

      // Every write path is blocked.
      const writes: Promise<TestResponse>[] = [
        putDraft(f, "member", canvasId, {
          expectedRevision: 1,
          baseVersionId: null,
          body: publishableBody("x"),
        }),
        publish(f, "member", canvasId, {
          expectedRevision: 1,
          idempotencyKey: `k-${randomUUID()}`,
        }),
        f
          .api("member")
          .post(`/api/v1/canvases/${canvasId}/draft`)
          .send({}) as unknown as Promise<TestResponse>,
      ];
      for (const w of writes) {
        const res = await w;
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("CANVAS_ARCHIVED");
      }

      const audit = await f
        .db("audit_event")
        .where({ action: "canvas.archive", target_id: canvasId })
        .first();
      expect(audit).toBeDefined();
      expect(audit.actor_id).toBe(f.ids.member);
    } finally {
      await f.close();
    }
  });

  it("is denied uniformly for subjects without access and re-archive is a conflict", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      for (const p of ["admin", "outsider"] as Persona[]) {
        expect((await archive(f, p, canvasId)).status, p).toBe(404);
      }
      expect((await archive(f, undefined, canvasId)).status).toBe(401);
      expect((await archive(f, "owner", randomUUID())).status).toBe(404);

      expect((await archive(f, "member", canvasId)).status).toBe(200);
      const again = await archive(f, "member", canvasId);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("CANVAS_ARCHIVED");
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/canvases/:id/transfer", () => {
  it("transfers ownership to an active same-company user — audited, access follows the new owner", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member, "Handoff");
      const res = await transfer(f, "owner", canvasId, {
        newOwnerId: f.ids.outsider,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const row = await f.db("canvas").where({ id: canvasId }).first();
      expect(row.owner_user_id).toBe(f.ids.outsider);

      // Access follows the NEW owner: outsider reads it, the old owner and
      // the old manager line no longer do.
      expect((await getCanvas(f, "outsider", canvasId)).status).toBe(200);
      expect((await getCanvas(f, "member", canvasId)).status).toBe(404);
      expect((await getCanvas(f, "manager", canvasId)).status).toBe(404);

      const audit = await f
        .db("audit_event")
        .where({ action: "canvas.transfer", target_id: canvasId })
        .first();
      expect(audit).toBeDefined();
      expect(audit.actor_id).toBe(f.ids.owner);
    } finally {
      await f.close();
    }
  });

  it("is owner-only — member/manager/admin are denied by role, not by subject scoping", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      // member has subject access (own canvas) but not the owner role;
      // manager has access via the subtree; admin has neither. All are
      // denied — the role check is what makes this "owner-only".
      for (const p of ["member", "manager", "admin"] as Persona[]) {
        const res = await transfer(f, p, canvasId, {
          newOwnerId: f.ids.outsider,
        });
        expect(res.status, p).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");
      }
      // Nothing moved.
      const row = await f.db("canvas").where({ id: canvasId }).first();
      expect(row.owner_user_id).toBe(f.ids.member);
    } finally {
      await f.close();
    }
  });

  it("rejects foreign, unknown and inactive targets", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasId = await mustCreate(f, "member", f.ids.member);
      for (const target of [randomUUID(), f.ids.otherCompany, "not-a-uuid"]) {
        const res = await transfer(f, "owner", canvasId, {
          newOwnerId: target,
        });
        expect([400, 404]).toContain(res.status);
      }

      await f
        .db("app_user")
        .where({ id: f.ids.outsider })
        .update({ status: "inactive" });
      const res = await transfer(f, "owner", canvasId, {
        newOwnerId: f.ids.outsider,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("USER_NOT_ACTIVE");
    } finally {
      await f.close();
    }
  });
});

describe("keyset cursor — impossible dates are 400, never 500", () => {
  it("rejects a non-round-trippable date on both keyset endpoints", async () => {
    const f = await fixture({ seeded: true });
    try {
      // 2026-02-31 passes a naive isFinite check (JS Date normalizes it to
      // Mar 3) then dies inside Postgres's ::timestamptz cast as 22008.
      const bad = `2026-02-31T00:00:00Z|${randomUUID()}`;
      const canvas = (await f
        .api("member")
        .get(
          `/api/v1/canvases?cursor=${encodeURIComponent(bad)}`,
        )) as unknown as TestResponse;
      expect(canvas.status).toBe(400);
      expect(canvas.body.code).toBe("INVALID_CURSOR");

      const audit = (await f
        .api("owner")
        .get(
          `/api/v1/audit?cursor=${encodeURIComponent(bad)}`,
        )) as unknown as TestResponse;
      expect(audit.status).toBe(400);
      expect(audit.body.code).toBe("INVALID_CURSOR");
    } finally {
      await f.close();
    }
  });
});
