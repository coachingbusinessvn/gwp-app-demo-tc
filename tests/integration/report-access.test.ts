import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixture, type Persona } from "../helpers/fixture.js";

/**
 * Task 4.1 — coaching sessions + report read ACL (spec §6):
 *
 *   POST /api/v1/coaching-sessions — the logged-in coach records a session
 *   GET  /api/v1/reports           — report list scoped by the report ACL
 *   GET  /api/v1/reports/:id       — one report, audited read
 *
 * Report rights are INDEPENDENT of the canvas subject policy: a report is
 * readable by its creator, the session's coach, an owner, or an active
 * report_share — never inferred from the reporting tree or canvas access.
 * The coach of a session must be the actor themself and the CURRENT manager
 * of the coachee; only an owner may enter a session on another coach's
 * behalf (audited). Denied, missing and foreign ids are the same 404.
 *
 * Seed tree (tests/helpers/seed-personas.ts):
 *   member → manager → owner,  outsider → owner,  admin (no reports)
 *
 * Report rows are seeded straight through f.db — the AI grading path that
 * produces them lands in task 4.2; the read ACL does not wait for it.
 */
type Fixture = Awaited<ReturnType<typeof fixture>>;
type TestResponse = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
};

function createSession(
  f: Fixture,
  persona: Persona | undefined,
  body: Record<string, unknown>,
): Promise<TestResponse> {
  return f
    .api(persona)
    .post("/api/v1/coaching-sessions")
    .send(body) as unknown as Promise<TestResponse>;
}

function getReport(
  f: Fixture,
  persona: Persona | undefined,
  id: string,
): Promise<TestResponse> {
  return f
    .api(persona)
    .get(`/api/v1/reports/${id}`) as unknown as Promise<TestResponse>;
}

function listReports(
  f: Fixture,
  persona: Persona | undefined,
  query = "",
): Promise<TestResponse> {
  return f
    .api(persona)
    .get(`/api/v1/reports${query}`) as unknown as Promise<TestResponse>;
}

/** A valid session payload: `coach` coaches `coachee`, occurred in the past. */
function sessionBody(
  coachUserId: string,
  coacheeUserId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    coachUserId,
    coacheeUserId,
    occurredAt: "2026-09-20T10:00:00.000Z",
    ...extra,
  };
}

/** Create a session through the real API; asserts 201 and returns the id. */
async function mustCreateSession(
  f: Fixture,
  persona: Persona,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await createSession(f, persona, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

const canonicalCanvas = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as unknown;

const REPORT_BODY = {
  schema: "oracle-report/v1",
  total: 42,
  steps: [{ step: "O", score: 7 }],
};

/**
 * Direct DB seed for a report row — the AI save path is task 4.2's.
 * createdBy defaults to the session's coach (the common case); an owner
 * entering on behalf produces a report whose creator is the owner.
 */
async function seedReport(
  f: Fixture,
  opts: {
    sessionId: string;
    createdBy: string;
    reportVersion?: number;
    body?: unknown;
  },
): Promise<string> {
  const id = randomUUID();
  await f.db("coaching_report").insert({
    id,
    company_id: f.ids.company,
    session_id: opts.sessionId,
    report_version: opts.reportVersion ?? 1,
    rubric_version: "ORACLE-v3",
    body: JSON.stringify(opts.body ?? REPORT_BODY),
    provenance: JSON.stringify({ model: "test-model", prompt_version: "p1" }),
    created_by: opts.createdBy,
  });
  return id;
}

async function seedShare(
  f: Fixture,
  reportId: string,
  userId: string,
  grantedBy: string,
  revoked = false,
): Promise<void> {
  await f.db("report_share").insert({
    report_id: reportId,
    company_id: f.ids.company,
    user_id: userId,
    granted_by: grantedBy,
    revoked_at: revoked ? new Date("2026-09-20T12:00:00Z") : null,
  });
}

describe("POST /api/v1/coaching-sessions", () => {
  it("lets a manager record a session for a subtree member; owner may coach anyone", async () => {
    const f = await fixture({ seeded: true });
    try {
      // manager (member's current manager) → 201.
      const res = await createSession(
        f,
        "manager",
        sessionBody(f.ids.manager, f.ids.member),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.id).toEqual(expect.any(String));

      const row = await f
        .db("coaching_session")
        .where({ id: res.body.id })
        .first();
      expect(row).toMatchObject({
        company_id: f.ids.company,
        coach_user_id: f.ids.manager,
        coachee_user_id: f.ids.member,
        created_by: f.ids.manager,
      });

      // owner coaches a user directly — no manager relation needed.
      expect(
        (
          await createSession(
            f,
            "owner",
            sessionBody(f.ids.owner, f.ids.outsider),
          )
        ).status,
      ).toBe(201);
    } finally {
      await f.close();
    }
  });

  it("denies a non-manager coach and any non-owner naming another coach", async () => {
    const f = await fixture({ seeded: true });
    try {
      // member coaches nobody — not a manager, not the owner.
      for (const coachee of [f.ids.manager, f.ids.outsider, f.ids.admin]) {
        expect(
          (await createSession(f, "member", sessionBody(f.ids.member, coachee)))
            .status,
          coachee,
        ).toBe(404);
      }
      // manager coaching outsider: outsider is outside manager's subtree.
      expect(
        (
          await createSession(
            f,
            "manager",
            sessionBody(f.ids.manager, f.ids.outsider),
          )
        ).status,
      ).toBe(404);
      // admin manages org metadata, not people — no coaching privilege.
      expect(
        (
          await createSession(
            f,
            "admin",
            sessionBody(f.ids.admin, f.ids.member),
          )
        ).status,
      ).toBe(404);

      // Impersonation: naming a DIFFERENT coach is owner-only — 403.
      // (member names manager; manager names owner; admin names manager.)
      for (const [p, coach] of [
        ["member", "manager"],
        ["manager", "owner"],
        ["admin", "manager"],
      ] as [Persona, Persona][]) {
        expect(
          (
            await createSession(
              f,
              p,
              sessionBody(f.ids[coach], f.ids.member),
            )
          ).status,
          p,
        ).toBe(403);
      }
      // Anonymous → 401.
      expect(
        (
          await createSession(
            f,
            undefined,
            sessionBody(f.ids.manager, f.ids.member),
          )
        ).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("lets the owner enter a session on another coach's behalf — audited", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Owner records a session where MANAGER coached OUTSIDER — a pairing
      // the manager could never create itself (outside its subtree).
      const res = await createSession(
        f,
        "owner",
        sessionBody(f.ids.manager, f.ids.outsider),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const row = await f
        .db("coaching_session")
        .where({ id: res.body.id })
        .first();
      expect(row).toMatchObject({
        coach_user_id: f.ids.manager,
        coachee_user_id: f.ids.outsider,
        created_by: f.ids.owner,
      });

      // The override is audited as its own action — metadata only.
      const audit = await f
        .db("audit_event")
        .where({ request_id: res.headers["x-request-id"] })
        .first();
      expect(audit).toMatchObject({
        actor_id: f.ids.owner,
        action: "coaching.session.create_on_behalf",
        target_type: "coaching_session",
        target_id: res.body.id,
      });
      expect(JSON.stringify(audit.safe_metadata)).not.toContain("Outsider");
    } finally {
      await f.close();
    }
  });

  it("links a canvas only when the actor can read it; unknown ids and malformed bodies are rejected", async () => {
    const f = await fixture({ seeded: true });
    try {
      const canvasRes = await f.api("member").post("/api/v1/canvases").send({
        ownerUserId: f.ids.member,
        name: "Canvas của member",
        body: canonicalCanvas,
      });
      expect(canvasRes.status).toBe(201);
      const canvasId = canvasRes.body.id as string;

      // manager can read member's canvas (subtree) → link allowed.
      expect(
        (
          await createSession(
            f,
            "manager",
            sessionBody(f.ids.manager, f.ids.member, { canvasId }),
          )
        ).status,
      ).toBe(201);

      // A canvas outside the actor's read scope denies the link — outsider's
      // canvas is unreadable to manager (cross-subtree) → uniform 404.
      const foreignCanvas = await f
        .api("owner")
        .post("/api/v1/canvases")
        .send({
          ownerUserId: f.ids.outsider,
          name: "Canvas của outsider",
          body: canonicalCanvas,
        });
      expect(foreignCanvas.status).toBe(201);
      expect(
        (
          await createSession(
            f,
            "manager",
            sessionBody(f.ids.manager, f.ids.member, {
              canvasId: foreignCanvas.body.id,
            }),
          )
        ).status,
      ).toBe(404);

      // Non-uuid body fields are schema errors, not 404/500.
      for (const bad of [
        sessionBody("not-a-uuid", f.ids.member),
        sessionBody(f.ids.manager, "not-a-uuid"),
        sessionBody(f.ids.manager, f.ids.member, { canvasId: "nope" }),
        sessionBody(f.ids.manager, f.ids.member, { occurredAt: "hôm qua" }),
        sessionBody(f.ids.manager, f.ids.member, {
          occurredAt: "2999-01-01T00:00:00Z",
        }),
        sessionBody(f.ids.manager, f.ids.member, { bogus: 1 }),
      ]) {
        const res = await createSession(f, "manager", bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(res.body.code).toBe("INVALID_INPUT");
      }

      // Unknown/foreign users and canvases → uniform 404.
      for (const bad of [
        sessionBody(randomUUID(), f.ids.member),
        sessionBody(f.ids.manager, randomUUID()),
        sessionBody(f.ids.manager, f.ids.member, {
          canvasId: randomUUID(),
        }),
        sessionBody(f.ids.otherCompany, f.ids.member),
      ]) {
        // Foreign/missing ids route through the owner so only the lookup
        // fails — a non-owner could legitimately 403/404 before resolving.
        expect(
          (await createSession(f, "owner", bad)).status,
          JSON.stringify(bad),
        ).toBe(404);
      }

      // Self-coaching is not a session.
      expect(
        (
          await createSession(
            f,
            "manager",
            sessionBody(f.ids.manager, f.ids.manager),
          )
        ).status,
      ).toBe(400);

      // An inactive coachee cannot take new sessions.
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ status: "inactive" });
      const res = await createSession(
        f,
        "manager",
        sessionBody(f.ids.manager, f.ids.member),
      );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("USER_NOT_ACTIVE");
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/reports/:id", () => {
  it("serves the report to creator, coach and owner only — coachee, admin, tree and foreign ids get the same 404", async () => {
    const f = await fixture({ seeded: true });
    try {
      const sessionId = await mustCreateSession(
        f,
        "manager",
        sessionBody(f.ids.manager, f.ids.member),
      );
      const reportId = await seedReport(f, {
        sessionId,
        createdBy: f.ids.manager,
      });

      // Coach (creator) and owner read it.
      for (const p of ["manager", "owner"] as Persona[]) {
        const res = await getReport(f, p, reportId);
        expect(res.status, p).toBe(200);
        expect(res.body).toMatchObject({
          id: reportId,
          sessionId,
          reportVersion: 1,
          rubricVersion: "ORACLE-v3",
          coachUserId: f.ids.manager,
          coacheeUserId: f.ids.member,
          createdBy: f.ids.manager,
        });
        expect(res.body.body).toMatchObject({ total: 42 });
      }

      // The COACHEE has no default right — the report evaluates the coach.
      expect((await getReport(f, "member", reportId)).status).toBe(404);
      // admin has no coaching privilege.
      expect((await getReport(f, "admin", reportId)).status).toBe(404);
      // outsider is unrelated to the session.
      expect((await getReport(f, "outsider", reportId)).status).toBe(404);

      // A NEW manager of the coachee does not inherit report access:
      // grant outsider the manager role and the reporting line, then the
      // read is still denied — report rights never follow the tree.
      const roleId = (
        await f.db("role").where({ key: "manager" }).first()
      ).id as string;
      await f.db("user_role").insert({
        company_id: f.ids.company,
        user_id: f.ids.outsider,
        role_id: roleId,
      });
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ manager_id: f.ids.outsider });
      expect((await getReport(f, "outsider", reportId)).status).toBe(404);

      // Missing, foreign-company and malformed ids are the same 404.
      for (const bad of [randomUUID(), f.ids.otherCompany, "not-a-uuid"]) {
        expect((await getReport(f, "owner", bad)).status, bad).toBe(404);
      }
      expect((await getReport(f, undefined, reportId)).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("honours report_share exactly — active share reads, revoked share denies from the next request", async () => {
    const f = await fixture({ seeded: true });
    try {
      const sessionId = await mustCreateSession(
        f,
        "manager",
        sessionBody(f.ids.manager, f.ids.member),
      );
      const reportId = await seedReport(f, {
        sessionId,
        createdBy: f.ids.manager,
      });

      await seedShare(f, reportId, f.ids.member, f.ids.owner);
      expect((await getReport(f, "member", reportId)).status).toBe(200);

      // Revocation is effective immediately — no caching window.
      await f
        .db("report_share")
        .where({ report_id: reportId, user_id: f.ids.member })
        .update({ revoked_at: new Date() });
      expect((await getReport(f, "member", reportId)).status).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("audits each authorized read with metadata only — never report content", async () => {
    const f = await fixture({ seeded: true });
    try {
      const sessionId = await mustCreateSession(
        f,
        "manager",
        sessionBody(f.ids.manager, f.ids.member),
      );
      const reportId = await seedReport(f, {
        sessionId,
        createdBy: f.ids.manager,
      });

      const res = await getReport(f, "owner", reportId);
      expect(res.status).toBe(200);
      const audit = await f
        .db("audit_event")
        .where({ request_id: res.headers["x-request-id"] })
        .first();
      expect(audit).toMatchObject({
        actor_id: f.ids.owner,
        action: "coaching.report.read",
        target_type: "coaching_report",
        target_id: reportId,
        outcome: "success",
      });
      // Metadata is sanitized on write — no body field can leak in.
      expect(audit.safe_metadata.body).toBeUndefined();
      expect(JSON.stringify(audit.safe_metadata)).not.toContain("42");

      // A denied read leaves no audit row (nothing was read).
      const denied = await getReport(f, "member", reportId);
      expect(denied.status).toBe(404);
      const deniedAudit = await f
        .db("audit_event")
        .where({ request_id: denied.headers["x-request-id"] })
        .first();
      expect(deniedAudit).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/reports", () => {
  it("scopes the list by the report ACL — not by the reporting tree", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Report A: manager coached member (normal path).
      const sessionA = await mustCreateSession(
        f,
        "manager",
        sessionBody(f.ids.manager, f.ids.member),
      );
      const reportA = await seedReport(f, {
        sessionId: sessionA,
        createdBy: f.ids.manager,
      });
      // Report B: owner coached outsider.
      const sessionB = await mustCreateSession(
        f,
        "owner",
        sessionBody(f.ids.owner, f.ids.outsider),
      );
      const reportB = await seedReport(f, {
        sessionId: sessionB,
        createdBy: f.ids.owner,
      });
      // Report C: owner entered on behalf — session coach is manager,
      // coachee outsider (outside manager's subtree), creator is owner.
      const sessionC = await mustCreateSession(
        f,
        "owner",
        sessionBody(f.ids.manager, f.ids.outsider),
      );
      const reportC = await seedReport(f, {
        sessionId: sessionC,
        createdBy: f.ids.owner,
      });

      const idsOf = (res: TestResponse): string[] =>
        (res.body.items as { id: string }[]).map((i) => i.id);

      // The session's coach reads its reports even when the coachee is
      // outside the current subtree — the ACL binds to the session row.
      const managerList = await listReports(f, "manager");
      expect(managerList.status).toBe(200);
      expect(idsOf(managerList).sort()).toEqual([reportA, reportC].sort());

      // Owner sees all three (creator B + owner role for A and C).
      expect(idsOf(await listReports(f, "owner")).sort()).toEqual(
        [reportA, reportB, reportC].sort(),
      );

      // member/admin/outsider have no default right to any of them.
      for (const p of ["member", "admin", "outsider"] as Persona[]) {
        const res = await listReports(f, p);
        expect(res.status, p).toBe(200);
        expect(res.body.items).toEqual([]);
      }

      // An active share admits member to exactly that report.
      await seedShare(f, reportB, f.ids.member, f.ids.owner);
      expect(idsOf(await listReports(f, "member"))).toEqual([reportB]);

      // Anonymous → 401.
      expect((await listReports(f, undefined)).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("paginates with the keyset cursor, filters by coacheeUserId and rejects bad params", async () => {
    const f = await fixture({ seeded: true });
    try {
      const sessionA = await mustCreateSession(
        f,
        "manager",
        sessionBody(f.ids.manager, f.ids.member),
      );
      const sessionB = await mustCreateSession(
        f,
        "owner",
        sessionBody(f.ids.owner, f.ids.outsider),
      );
      const reportA = await seedReport(f, {
        sessionId: sessionA,
        createdBy: f.ids.manager,
      });
      const reportB = await seedReport(f, {
        sessionId: sessionB,
        createdBy: f.ids.owner,
      });
      // A second version of session A's report is a separate row.
      const reportA2 = await seedReport(f, {
        sessionId: sessionA,
        createdBy: f.ids.manager,
        reportVersion: 2,
      });

      const page1 = await listReports(f, "owner", "?limit=2");
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await listReports(
        f,
        "owner",
        `?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      );
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();
      const seen = [...page1.body.items, ...page2.body.items].map(
        (i: { id: string }) => i.id,
      );
      expect(seen.sort()).toEqual([reportA, reportA2, reportB].sort());

      // coacheeUserId filter — owner narrows to member's report rows.
      const filtered = await listReports(
        f,
        "owner",
        `?coacheeUserId=${f.ids.member}`,
      );
      expect(
        (filtered.body.items as { id: string }[]).map((i) => i.id).sort(),
      ).toEqual([reportA, reportA2].sort());
      // A coachee filter naming a user with no reports → empty page.
      const empty = await listReports(
        f,
        "owner",
        `?coacheeUserId=${f.ids.admin}`,
      );
      expect(empty.body.items).toEqual([]);

      for (const bad of [
        "?limit=0",
        "?limit=101",
        "?limit=abc",
        "?cursor=nope",
        `?coacheeUserId=not-a-uuid`,
      ]) {
        expect((await listReports(f, "owner", bad)).status, bad).toBe(400);
      }
      // The filter never widens scope: a shared-out report for outsider
      // still isn't visible to member just by naming the filter.
      const denied = await listReports(
        f,
        "member",
        `?coacheeUserId=${f.ids.outsider}`,
      );
      expect(denied.status).toBe(200);
      expect(denied.body.items).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
