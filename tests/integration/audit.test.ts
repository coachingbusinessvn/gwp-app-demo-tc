import { describe, expect, it } from "vitest";
import { fixture } from "../helpers/fixture.js";

/**
 * Task 1.5 — GET /api/v1/audit (spec §4/§9, controller ruling).
 *
 * Owner/admin only; rows are metadata-only DTOs — id, at, actorId,
 * action, outcome, requestId, targetType/targetId and the safe_metadata
 * allowlist re-applied on READ (a poisoned row still serializes clean).
 * Keyset pagination is newest-first over (created_at, id) — 25 default,
 * 100 cap like every other list.
 */
type TestResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};

const ROW_KEYS = [
  "action",
  "actorId",
  "at",
  "id",
  "metadata",
  "outcome",
  "requestId",
  "targetId",
  "targetType",
].sort();

describe("GET /api/v1/audit", () => {
  it("is owner/admin only — member, manager and anonymous are denied", async () => {
    const f = await fixture({ seeded: true });
    try {
      for (const persona of ["member", "manager", "outsider"] as const) {
        const res = (await f
          .api(persona)
          .get("/api/v1/audit")) as unknown as TestResponse;
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("FORBIDDEN");
      }
      const anon = (await f
        .api()
        .get("/api/v1/audit")) as unknown as TestResponse;
      expect(anon.status).toBe(401);
      for (const persona of ["owner", "admin"] as const) {
        const res = (await f
          .api(persona)
          .get("/api/v1/audit")) as unknown as TestResponse;
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.items)).toBe(true);
      }
    } finally {
      await f.close();
    }
  });

  it("serializes metadata-only rows and re-redacts by the allowlist on read", async () => {
    const f = await fixture({ seeded: true });
    try {
      // A poisoned row written directly (the runtime role holds INSERT on
      // audit_event): non-allowlisted keys and non-scalar values must be
      // dropped on read, even though the writer would have stripped them.
      await f.db("audit_event").insert({
        company_id: f.ids.company,
        actor_id: f.ids.owner,
        action: "test.probe",
        outcome: "success",
        request_id: "req-poison",
        safe_metadata: {
          role: "admin", // allowlisted scalar — survives
          secret: "drop-me", // not in AUDIT_METADATA_ALLOWLIST — dropped
          nested: { a: 1 }, // non-scalar — dropped
          overlong: "y".repeat(201), // >200 chars — dropped
        },
      });

      const res = (await f
        .api("owner")
        .get("/api/v1/audit?limit=100")) as unknown as TestResponse;
      expect(res.status).toBe(200);
      const items = res.body.items as Record<string, unknown>[];
      const row = items.find((r) => r.action === "test.probe");
      expect(row).toBeDefined();
      expect(Object.keys(row!).sort()).toEqual(ROW_KEYS);
      expect(row!.metadata).toEqual({ role: "admin" });
      expect(row!.actorId).toBe(f.ids.owner);
      expect(row!.targetType).toBeNull();
      expect(row!.targetId).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("paginates newest-first with a keyset cursor and validates params", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Three known events, inserted in order.
      for (const action of ["e.one", "e.two", "e.three"]) {
        await f.db("audit_event").insert({
          company_id: f.ids.company,
          actor_id: f.ids.admin,
          action,
          outcome: "success",
          request_id: `req-${action}`,
          safe_metadata: {},
        });
        // Distinct created_at so the ordering assertion is deterministic.
        // audit_event is append-only for the runtime role, so this test
        // backdating goes through the maintenance connection.
        await f.maintenanceDb.raw(
          `UPDATE audit_event SET created_at = now() - interval '1 second' * ? WHERE action = ?`,
          [action === "e.one" ? 3 : action === "e.two" ? 2 : 1, action],
        );
      }

      const page1 = (await f
        .api("owner")
        .get("/api/v1/audit?limit=2")) as unknown as TestResponse;
      expect(page1.status).toBe(200);
      const p1 = page1.body as { items: { action: string }[]; nextCursor: string | null };
      expect(p1.items).toHaveLength(2);
      expect(p1.items[0].action).toBe("e.three"); // newest first
      expect(p1.items[1].action).toBe("e.two");
      expect(typeof p1.nextCursor).toBe("string");

      const page2 = (await f
        .api("owner")
        .get(
          `/api/v1/audit?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`,
        )) as unknown as TestResponse;
      const p2 = page2.body as { items: { action: string }[]; nextCursor: string | null };
      expect(p2.items[0].action).toBe("e.one");
      // Seed logins also wrote auth.login events before ours — they may
      // follow e.one; only the leading item is asserted.

      const badCursor = (await f
        .api("owner")
        .get("/api/v1/audit?cursor=not-a-cursor")) as unknown as TestResponse;
      expect(badCursor.status).toBe(400);
      expect(badCursor.body.code).toBe("INVALID_CURSOR");

      const badLimit = (await f
        .api("owner")
        .get("/api/v1/audit?limit=0")) as unknown as TestResponse;
      expect(badLimit.status).toBe(400);
      expect(badLimit.body.code).toBe("INVALID_LIMIT");
    } finally {
      await f.close();
    }
  });
});
