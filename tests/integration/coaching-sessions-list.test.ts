import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, type Persona } from "../helpers/fixture.js";

/**
 * GET /api/v1/coaching-sessions — the actor's own sessions, so a session
 * without a report survives a page reload.
 *
 * Visibility: an owner sees the company; anyone else sees sessions where
 * they are the coach of record, the creator, or the COACHEE (read-only —
 * the write gate is unchanged, and reports keep their own ACL). The
 * coachee's other managers, admin and readers of a linked canvas see
 * nothing. Each item carries `relation` so clients know which rows are
 * read-only; a coachee-only row hides a linked canvas that isn't theirs. Keyset pagination is the shared (created_at, id) cursor —
 * limit 1..100, malformed cursors 400.
 *
 * Seed tree: member → manager → owner, outsider → owner, admin.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as unknown;
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
  canvasId?: string,
): Promise<string> {
  const res = (await f
    .api(persona)
    .post("/api/v1/coaching-sessions")
    .send({ coachUserId, coacheeUserId, occurredAt, canvasId })) as unknown as TestResponse;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe("GET /api/v1/coaching-sessions", () => {
  it("scopes to coach / creator / coachee; owner sees all; admin and unrelated users see none", async () => {
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

      // The coachee sees the sessions about them — read-only relation.
      const coachee = await list(f, "member");
      expect(coachee.status).toBe(200);
      expect(
        coachee.body.items.map((s: { id: string }) => s.id).sort(),
      ).toEqual([mine, onBehalf].sort());
      for (const item of coachee.body.items) {
        expect(item.relation).toBe("coachee");
      }
      const outsider = await list(f, "outsider");
      expect(outsider.body.items.map((s: { id: string }) => s.id)).toEqual([
        ownerOwn,
      ]);

      // Admin is unrelated to every session — nothing.
      const admin = await list(f, "admin");
      expect(admin.status).toBe(200);
      expect(admin.body.items).toEqual([]);
      expect((await list(f, undefined)).status).toBe(401);

      // Relation precedence for the other viewers.
      const rel = (r: TestResponse, id: string) =>
        r.body.items.find((s: { id: string }) => s.id === id).relation;
      expect(rel(mgr, mine)).toBe("coach");
      expect(rel(mgr, onBehalf)).toBe("coach");
      expect(rel(own, onBehalf)).toBe("creator");
      expect(rel(own, mine)).toBe("owner");

      const item = mgr.body.items.find((s: { id: string }) => s.id === mine);
      expect(item).toEqual({
        id: mine,
        coachUserId: f.ids.manager,
        coacheeUserId: f.ids.member,
        canvasId: null,
        occurredAt: "2026-09-20T10:00:00.000Z",
        createdBy: f.ids.manager,
        createdAt: expect.any(String),
        relation: "coach",
      });
      // Newest first.
      expect(own.body.items[0].id).toBe(ownerOwn);
    } finally {
      await f.close();
    }
  });

  it("shows a coachee a linked canvas only when it is their own", async () => {
    const f = await fixture({ seeded: true });
    try {
      const mkCanvas = async (ownerUserId: string, name: string) => {
        const res = (await f
          .api("manager")
          .post("/api/v1/canvases")
          .send({ ownerUserId, name, body: canonical })) as unknown as TestResponse;
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.id as string;
      };
      const theirs = await mkCanvas(f.ids.member, "Canvas của coachee");
      const managers = await mkCanvas(f.ids.manager, "Canvas của quản lý");
      const withTheirs = await mustCreate(
        f, "manager", f.ids.manager, f.ids.member,
        "2026-09-21T10:00:00.000Z", theirs,
      );
      const withManagers = await mustCreate(
        f, "manager", f.ids.manager, f.ids.member,
        "2026-09-22T10:00:00.000Z", managers,
      );

      const byId = (r: TestResponse) =>
        Object.fromEntries(
          r.body.items.map((s: { id: string; canvasId: string | null }) => [
            s.id,
            s.canvasId,
          ]),
        );
      const coachee = byId(await list(f, "member"));
      expect(coachee[withTheirs]).toBe(theirs);
      expect(coachee[withManagers]).toBeNull();

      // The coach still sees both links.
      const coach = byId(await list(f, "manager"));
      expect(coach[withTheirs]).toBe(theirs);
      expect(coach[withManagers]).toBe(managers);
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
