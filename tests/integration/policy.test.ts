import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPolicy } from "../../server/src/modules/authorization/policy.js";
import { fixture, PERSONAS, type Persona } from "../helpers/fixture.js";

/**
 * Task 1.2 — subject policy + reporting tree (spec §3/§4).
 *
 * Access to a subject = self OR owner (whole company) OR the actor holds the
 * manager role AND the subject sits in the actor's CURRENT reporting subtree
 * (app_user.manager_id recursive walk). Roles and the tree are re-read from
 * the DB on every check — nothing is cached in the ActorContext or the JWT,
 * so a manager change revokes/grants access on the very next call. Admin is
 * org-metadata only: no subtree, no self-grafting into the tree. Every
 * denial is the same 404 — subject ids are never enumerable.
 *
 * Seed tree (tests/helpers/seed-personas.ts):
 *   member → manager → owner,  outsider → owner
 * so manager's subtree is {member} and outsider is inside the company but
 * outside that subtree.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
type TestResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};

function putManager(
  f: Fixture,
  persona: Persona | undefined,
  userId: string,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .put(`/api/v1/users/${userId}/manager`)
    .send(body) as unknown as Promise<TestResponse>;
}

describe("subject policy — persona matrix (spec §4)", () => {
  it("allows exactly self + owner-all + manager-subtree and nothing else", async () => {
    const f = await fixture({ seeded: true });
    try {
      const policy = createPolicy(f.db);
      const matrix: Record<Persona, Persona[]> = {
        owner: ["owner", "admin", "manager", "member", "outsider"],
        // Admin reads org metadata only — no subtree privilege at all.
        admin: ["admin"],
        manager: ["manager", "member"],
        member: ["member"],
        outsider: ["outsider"],
      };
      for (const actor of PERSONAS) {
        for (const subject of PERSONAS) {
          const expected = matrix[actor].includes(subject);
          expect(
            await policy.canAccessSubject(f.actor(actor), f.ids[subject]),
            `${actor} → ${subject}`,
          ).toBe(expected);
        }
      }
    } finally {
      await f.close();
    }
  });

  it("assertSubjectAccess resolves when allowed and throws a uniform 404 when denied", async () => {
    const f = await fixture({ seeded: true });
    try {
      const policy = createPolicy(f.db);
      await expect(
        policy.assertSubjectAccess(f.actor("member"), f.ids.member),
      ).resolves.toBeUndefined();
      await expect(
        policy.assertSubjectAccess(f.actor("manager"), f.ids.member),
      ).resolves.toBeUndefined();
      await expect(
        policy.assertSubjectAccess(f.actor("owner"), f.ids.outsider),
      ).resolves.toBeUndefined();

      for (const [actor, subject] of [
        ["admin", "member"],
        ["admin", "manager"],
        ["manager", "outsider"],
        ["manager", "owner"],
        ["member", "manager"],
        ["outsider", "member"],
      ] as [Persona, Persona][]) {
        await expect(
          policy.assertSubjectAccess(f.actor(actor), f.ids[subject]),
          `${actor} → ${subject}`,
        ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      }

      // Nonexistent or foreign subject ids are the same 404 — no leak.
      await expect(
        policy.assertSubjectAccess(f.actor("owner"), randomUUID()),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      await expect(
        policy.assertSubjectAccess(f.actor("owner"), f.ids.otherCompany),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      // A malformed id can never be a subject — deny, never crash on a cast.
      await expect(
        policy.assertSubjectAccess(f.actor("owner"), "not-a-uuid"),
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    } finally {
      await f.close();
    }
  });

  it("scopeSubjectIds returns each actor's visible subject set", async () => {
    const f = await fixture({ seeded: true });
    try {
      const policy = createPolicy(f.db);
      const scope = async (p: Persona) =>
        (await policy.scopeSubjectIds(f.actor(p))).sort();
      expect(await scope("owner")).toEqual(
        PERSONAS.map((p) => f.ids[p]).sort(),
      );
      expect(await scope("manager")).toEqual(
        [f.ids.manager, f.ids.member].sort(),
      );
      expect(await scope("admin")).toEqual([f.ids.admin]);
      expect(await scope("member")).toEqual([f.ids.member]);
      expect(await scope("outsider")).toEqual([f.ids.outsider]);
    } finally {
      await f.close();
    }
  });

  it("an inactive actor gets no access to anything — defense in depth behind authenticate()", async () => {
    const f = await fixture({ seeded: true });
    try {
      const policy = createPolicy(f.db);
      await f
        .db("app_user")
        .where({ id: f.ids.manager })
        .update({ status: "inactive" });
      // Even self-access is denied for an inactive actor.
      expect(
        await policy.canAccessSubject(f.actor("manager"), f.ids.manager),
      ).toBe(false);
      expect(
        await policy.canAccessSubject(f.actor("manager"), f.ids.member),
      ).toBe(false);
      await expect(
        policy.assertSubjectAccess(f.actor("manager"), f.ids.member),
      ).rejects.toMatchObject({ status: 404 });
      expect(await policy.scopeSubjectIds(f.actor("manager"))).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("a dirty-data cycle already in the table cannot hang the recursive walk", async () => {
    const f = await fixture({ seeded: true });
    try {
      const policy = createPolicy(f.db);
      // Simulate dirty data — a 2-cycle written straight past the service
      // (the DB enforces no cycle constraint; the visited-path CTE must
      // terminate anyway).
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ manager_id: f.ids.outsider });
      await f
        .db("app_user")
        .where({ id: f.ids.outsider })
        .update({ manager_id: f.ids.member });

      // Give member the manager role (direct row — the role API is task 1.3)
      // so the subtree walk actually runs over the cyclic rows.
      const mgr = (await f.db("role").where({ key: "manager" }).first()) as {
        id: string;
      };
      await f.db("user_role").insert({
        company_id: f.ids.company,
        user_id: f.ids.member,
        role_id: mgr.id,
      });

      const ids = (await policy.scopeSubjectIds(f.actor("member"))).sort();
      expect(ids).toEqual([f.ids.member, f.ids.outsider].sort());
      expect(
        await policy.canAccessSubject(f.actor("member"), f.ids.outsider),
      ).toBe(true);
      // The cycle does not leak outside itself.
      expect(
        await policy.canAccessSubject(f.actor("member"), f.ids.admin),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
});

describe("PUT /api/v1/users/:id/manager", () => {
  it("is owner-only: admin cannot graft itself into the tree (403); anonymous gets 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      // The self-escalation attempt from the task brief.
      const graft = await putManager(f, "admin", f.ids.member, {
        managerId: f.ids.admin,
      });
      expect(graft.status).toBe(403);
      for (const p of ["manager", "member", "outsider"] as Persona[]) {
        const res = await putManager(f, p, f.ids.member, {
          managerId: f.ids.owner,
        });
        expect(res.status, p).toBe(403);
      }
      const anon = await putManager(f, undefined, f.ids.member, {
        managerId: f.ids.owner,
      });
      expect(anon.status).toBe(401);

      // Nothing moved.
      const row = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(row.manager_id).toBe(f.ids.manager);
    } finally {
      await f.close();
    }
  });

  it("owner reassigns and clears a reporting line; effects land on the very next policy read", async () => {
    const f = await fixture({ seeded: true });
    try {
      const policy = createPolicy(f.db);
      expect(
        await policy.canAccessSubject(f.actor("manager"), f.ids.member),
      ).toBe(true);
      expect(
        await policy.canAccessSubject(f.actor("manager"), f.ids.outsider),
      ).toBe(false);

      // Move member under outsider.
      const moved = await putManager(f, "owner", f.ids.member, {
        managerId: f.ids.outsider,
      });
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({
        id: f.ids.member,
        managerId: f.ids.outsider,
      });
      const row = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(row.manager_id).toBe(f.ids.outsider);

      // Immediate revocation: the old manager loses member — no cache.
      expect(
        await policy.canAccessSubject(f.actor("manager"), f.ids.member),
      ).toBe(false);
      // A tree parent WITHOUT the manager role gains nothing (spec §4).
      expect(
        await policy.canAccessSubject(f.actor("outsider"), f.ids.member),
      ).toBe(false);

      // Grant outsider the manager role directly (role API is task 1.3) —
      // the very next read picks it up: roles are never cached.
      const mgr = (await f.db("role").where({ key: "manager" }).first()) as {
        id: string;
      };
      await f.db("user_role").insert({
        company_id: f.ids.company,
        user_id: f.ids.outsider,
        role_id: mgr.id,
      });
      expect(
        await policy.canAccessSubject(f.actor("outsider"), f.ids.member),
      ).toBe(true);

      // The write and its audit row committed atomically.
      const audit = await f
        .db("audit_event")
        .where({
          action: "org.user.set_manager",
          request_id: moved.headers["x-request-id"],
        })
        .first();
      expect(audit).toMatchObject({
        actor_id: f.ids.owner,
        target_type: "app_user",
        target_id: f.ids.member,
        outcome: "success",
      });

      // managerId: null unassigns — outsider loses member again.
      const cleared = await putManager(f, "owner", f.ids.member, {
        managerId: null,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.managerId).toBeNull();
      expect(
        await policy.canAccessSubject(f.actor("outsider"), f.ids.member),
      ).toBe(false);

      // The new manager gains the moved report: outsider under manager.
      const under = await putManager(f, "owner", f.ids.outsider, {
        managerId: f.ids.manager,
      });
      expect(under.status).toBe(200);
      expect(
        await policy.canAccessSubject(f.actor("manager"), f.ids.outsider),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("rejects self-manager (400), subtree cycles (409), unknown/foreign ids (404) and malformed bodies (400)", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Self-assignment is statically invalid input.
      const self = await putManager(f, "owner", f.ids.owner, {
        managerId: f.ids.owner,
      });
      expect(self.status).toBe(400);

      // member sits in manager's current subtree — pointing manager at
      // member would close a cycle → clean 409, never a 500.
      const cyc = await putManager(f, "owner", f.ids.manager, {
        managerId: f.ids.member,
      });
      expect(cyc.status).toBe(409);
      expect(cyc.body.code).toBe("REPORTING_CYCLE");

      // Unknown, foreign and non-uuid ids — consistent 404, no enumeration.
      expect(
        (await putManager(f, "owner", randomUUID(), { managerId: f.ids.owner }))
          .status,
      ).toBe(404);
      expect(
        (await putManager(f, "owner", "not-a-uuid", { managerId: f.ids.owner }))
          .status,
      ).toBe(404);
      expect(
        (
          await putManager(f, "owner", f.ids.member, {
            managerId: randomUUID(),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await putManager(f, "owner", f.ids.member, {
            managerId: f.ids.otherCompany,
          })
        ).status,
      ).toBe(404);

      // Malformed bodies → 400 (strict schema; managerId may be null but
      // the key is required and must be a uuid when present).
      expect((await putManager(f, "owner", f.ids.member, {})).status).toBe(400);
      expect(
        (await putManager(f, "owner", f.ids.member, { managerId: "nope" }))
          .status,
      ).toBe(400);
      expect(
        (
          await putManager(f, "owner", f.ids.member, {
            managerId: f.ids.owner,
            role: "owner",
          })
        ).status,
      ).toBe(400);

      // Tree untouched by all of the above.
      const member = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(member.manager_id).toBe(f.ids.manager);
      const owner = await f.db("app_user").where({ id: f.ids.owner }).first();
      expect(owner.manager_id).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("requires both the subject and the new manager to be active (409)", async () => {
    const f = await fixture({ seeded: true });
    try {
      await f
        .db("app_user")
        .where({ id: f.ids.outsider })
        .update({ status: "inactive" });

      // An inactive account cannot be pointed at as a manager.
      const target = await putManager(f, "owner", f.ids.member, {
        managerId: f.ids.outsider,
      });
      expect(target.status).toBe(409);
      // Nor can an inactive subject be re-grafted.
      const subject = await putManager(f, "owner", f.ids.outsider, {
        managerId: f.ids.owner,
      });
      expect(subject.status).toBe(409);

      const member = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(member.manager_id).toBe(f.ids.manager);
      const outsider = await f
        .db("app_user")
        .where({ id: f.ids.outsider })
        .first();
      expect(outsider.manager_id).toBe(f.ids.owner);
    } finally {
      await f.close();
    }
  });

  it("serializes concurrent edits that would form a cycle — exactly one wins, never a 500", async () => {
    const f = await fixture({ seeded: true });
    try {
      // member→outsider and outsider→member are each legal alone but form a
      // 2-cycle together. Two real connections race; the company lock
      // serializes them and the loser re-reads the winner's committed tree.
      const [a, b] = await Promise.all([
        putManager(f, "owner", f.ids.member, { managerId: f.ids.outsider }),
        putManager(f, "owner", f.ids.outsider, { managerId: f.ids.member }),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe("REPORTING_CYCLE");

      // Exactly one edge landed — the committed tree is acyclic.
      const member = await f.db("app_user").where({ id: f.ids.member }).first();
      const outsider = await f
        .db("app_user")
        .where({ id: f.ids.outsider })
        .first();
      const edges = [
        member.manager_id === f.ids.outsider,
        outsider.manager_id === f.ids.member,
      ];
      expect(edges.filter(Boolean)).toHaveLength(1);

      // And the committed state is self-consistent for the policy walk.
      const policy = createPolicy(f.db);
      if (member.manager_id === f.ids.outsider) {
        expect(
          await policy.canAccessSubject(f.actor("manager"), f.ids.member),
        ).toBe(false); // member left manager's subtree
      } else {
        expect(
          await policy.canAccessSubject(f.actor("manager"), f.ids.outsider),
        ).toBe(true); // outsider joined it
      }
    } finally {
      await f.close();
    }
  });
});
