import { describe, expect, it } from "vitest";
import { fixture, type Persona } from "../helpers/fixture.js";

/**
 * GET /api/v1/coaching-sessions — the actor's own sessions, so a session
 * without a report survives a page reload.
 *
 * Visibility mirrors the existing session relation (policy.ts
 * assertSessionWrite) and never widens it: an owner sees the company; anyone
 * else sees only sessions where they are the coach of record or the
 * creator. The coachee, the coachee's other managers, admin and readers of
 * a linked canvas see nothing (spec §6: none of them gain coaching rights
 * by relation). Keyset pagination is the shared (created_at, id) cursor —
 * limit 1..100, malformed cursors 400.
 *
 * Seed tree: member → manager → owner, outsider → owner, admin.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
type TestResponse = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
};

function list(
  f: Fixture,
  persona: Persona | undefined,
  query = "",
): Promise<TestResponse> {
  return f
    .api(persona)
    .get(`/api/v1/coaching-sessions${query}`) as unknown as Promise<TestResponse>;
}

async function mustCreate(
  f: Fixture,
  persona: Persona,
  coachUserId: string,
  coacheeUserId: string,
  occurredAt = "2026-09-20T10:00:00.000Z",
): Promise<string> {
  const res = (await f
    .api(persona)
    .post("/api/v1/coaching-sessions")
    .send({ coachUserId, coacheeUserId, occurredAt })) as unknown as TestResponse;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe("GET /api/v1/coaching-sessions", () => {
  it("scopes to coach-of-record / creator; owner sees all; coachee, admin and outsiders see none", async () => {
    const f = await fixture({ seeded: true });
    try {
      const mine = await mustCreate(f, "manager", f.ids.manager, f.ids.member);
      // Owner enters a historical session on manager's behalf: manager is
      // the coach of record (visible to them); owner is the creator.
      const onBehalf = await mustCreate(f, "owner", f.ids.manager, f.ids.member);
      const ownerOwn = await mustCreate(f, "owner", f.ids.owner, f.ids.outsider);

      const mgr = await list(f, "manager");
      expect(mgr.status).toBe(200);
      expect(mgr.body.items.map((s: { id: string }) => s.id).sort()).toEqual(
        [mine, onBehalf].sort(),
      );
      expect(mgr.body.nextCursor).toBeNull();

      const own = await list(f, "owner");
      expect(own.body.items.map((s: { id: string }) => s.id).sort()).toEqual(
        [mine, onBehalf, ownerOwn].sort(),
      );

      // The coachee never sees sessions about them; nor do admin/outsider.
      for (const p of ["member", "admin", "outsider"] as const) {
        const r = await list(f, p);
        expect(r.status, p).toBe(200);
        expect(r.body.items, p).toEqual([]);
      }
      expect((await list(f, undefined)).status).toBe(401);

      const item = mgr.body.items.find((s: { id: string }) => s.id === mine);
      expect(item).toEqual({
        id: mine,
        coachUserId: f.ids.manager,
        coacheeUserId: f.ids.member,
        canvasId: null,
        occurredAt: "2026-09-20T10:00:00.000Z",
        createdBy: f.ids.manager,
        createdAt: expect.any(String),
      });
      // Newest first.
      expect(own.body.items[0].id).toBe(ownerOwn);
    } finally {
      await f.close();
    }
  });

  it("paginates with the shared keyset cursor and rejects bad limit/cursor", async () => {
    const f = await fixture({ seeded: true });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await mustCreate(f, "manager", f.ids.manager, f.ids.member));
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = cursor
          ? `?limit=1&cursor=${encodeURIComponent(cursor)}`
          : "?limit=1";
        const r = await list(f, "manager", q);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.items.length).toBeLessThanOrEqual(1);
        seen.push(...r.body.items.map((s: { id: string }) => s.id));
        cursor = r.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toHaveLength(3);
      expect(new Set(seen)).toEqual(new Set(ids));

      expect((await list(f, "manager", "?limit=0")).body.code).toBe("INVALID_LIMIT");
      expect((await list(f, "manager", "?limit=101")).status).toBe(400);
      const bad = await list(f, "manager", "?cursor=garbage");
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe("INVALID_CURSOR");
    } finally {
      await f.close();
    }
  });
});
