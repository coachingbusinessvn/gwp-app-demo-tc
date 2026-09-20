import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrgService } from "../../server/src/modules/org/service.js";
import { fixture } from "../helpers/fixture.js";

/**
 * Task 1.1 — organization schema + scoped CRUD/archive (spec §3, §4).
 *
 * One deployment = one company: there is no company-create endpoint at all,
 * org mutations are owner/admin only under the company lock, archived units
 * keep their rows/FKs, and the composite (company_id, …) FKs make a user
 * assignment whose department does not match the team's department
 * impossible at the database level.
 */
type TestResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};

async function createDepartment(
  f: Awaited<ReturnType<typeof fixture>>,
  persona: "owner" | "admin",
  name: string,
): Promise<{ id: string; name: string; archivedAt: string | null }> {
  const res = (await f
    .api(persona)
    .post("/api/v1/departments")
    .send({ name })) as unknown as TestResponse;
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string; archivedAt: string | null };
}

async function createTeam(
  f: Awaited<ReturnType<typeof fixture>>,
  persona: "owner" | "admin",
  departmentId: string,
  name: string,
): Promise<{
  id: string;
  departmentId: string;
  name: string;
  archivedAt: string | null;
}> {
  const res = (await f
    .api(persona)
    .post("/api/v1/teams")
    .send({ departmentId, name })) as unknown as TestResponse;
  expect(res.status).toBe(201);
  return res.body as {
    id: string;
    departmentId: string;
    name: string;
    archivedAt: string | null;
  };
}

describe("POST /api/v1/departments", () => {
  it("owner and admin can create departments; the response is camelCase", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = (await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Vận hành" })) as unknown as TestResponse;
      expect(dep.status).toBe(201);
      expect(dep.body).toMatchObject({ name: "Vận hành", archivedAt: null });
      expect(typeof dep.body.id).toBe("string");

      const byOwner = (await f
        .api("owner")
        .post("/api/v1/departments")
        .send({ name: "Kinh doanh" })) as unknown as TestResponse;
      expect(byOwner.status).toBe(201);

      // Row landed in this company only.
      const row = await f
        .db("department")
        .where({ id: dep.body.id })
        .first();
      expect(row).toMatchObject({
        company_id: f.ids.company,
        name: "Vận hành",
        archived_at: null,
      });
    } finally {
      await f.close();
    }
  });

  it("member, manager and anonymous callers get 403/401 — org mutation is owner/admin only", async () => {
    const f = await fixture({ seeded: true });
    try {
      expect(
        (
          (await f
            .api("member")
            .post("/api/v1/departments")
            .send({ name: "Sai" })) as unknown as TestResponse
        ).status,
      ).toBe(403);
      expect(
        (
          (await f
            .api("manager")
            .post("/api/v1/departments")
            .send({ name: "Sai" })) as unknown as TestResponse
        ).status,
      ).toBe(403);
      expect(
        (
          (await f
            .api("outsider")
            .post("/api/v1/departments")
            .send({ name: "Sai" })) as unknown as TestResponse
        ).status,
      ).toBe(403);
      // Anonymous — no Bearer token at all.
      expect(
        (
          (await f
            .api()
            .post("/api/v1/departments")
            .send({ name: "Sai" })) as unknown as TestResponse
        ).status,
      ).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("strict bodies: empty/missing name and privilege keys like role/managerId are 400", async () => {
    const f = await fixture({ seeded: true });
    try {
      for (const body of [
        {},
        { name: "" },
        { name: "   " },
        { name: "Ok", role: "owner" },
        { name: "Ok", managerId: f.ids.owner },
        { name: "Ok", companyId: f.ids.otherCompany },
      ]) {
        const res = (await f
          .api("admin")
          .post("/api/v1/departments")
          .send(body)) as unknown as TestResponse;
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe("INVALID_INPUT");
      }
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/departments", () => {
  it("lists company-scoped departments with cursor pagination (default 25, max 100)", async () => {
    const f = await fixture({ seeded: true });
    try {
      await createDepartment(f, "admin", "Ban A");
      await createDepartment(f, "admin", "Ban B");
      await createDepartment(f, "admin", "Ban C");

      // Members can read org metadata — the matrix restricts mutations.
      const page1 = (await f
        .api("member")
        .get("/api/v1/departments?limit=2")) as unknown as TestResponse;
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(typeof page1.body.nextCursor).toBe("string");

      const page2 = (await f
        .api("member")
        .get(
          `/api/v1/departments?limit=2&cursor=${page1.body.nextCursor}`,
        )) as unknown as TestResponse;
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.nextCursor).toBeNull();

      const ids = [
        ...(page1.body.items as { id: string }[]),
        ...(page2.body.items as { id: string }[]),
      ].map((d) => d.id);
      expect(new Set(ids).size).toBe(3);

      // Boundaries: limit is an integer in [1,100].
      for (const bad of ["0", "101", "-1", "abc", "1.5"]) {
        const res = (await f
          .api("member")
          .get(
            `/api/v1/departments?limit=${bad}`,
          )) as unknown as TestResponse;
        expect(res.status, `limit=${bad}`).toBe(400);
      }
      const max = (await f
        .api("member")
        .get("/api/v1/departments?limit=100")) as unknown as TestResponse;
      expect(max.status).toBe(200);

      // A cursor that is not a UUID is rejected, not crashed on a cast.
      const badCursor = (await f
        .api("member")
        .get("/api/v1/departments?cursor=not-a-uuid")) as unknown as TestResponse;
      expect(badCursor.status).toBe(400);
    } finally {
      await f.close();
    }
  });
});

describe("PATCH /api/v1/departments/:id", () => {
  it("renames a department (owner/admin); 404 on unknown id, 403 for member", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await createDepartment(f, "owner", "Cũ");

      const renamed = (await f
        .api("admin")
        .patch(`/api/v1/departments/${dep.id}`)
        .send({ name: "Mới" })) as unknown as TestResponse;
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ id: dep.id, name: "Mới" });

      expect(
        (
          (await f
            .api("member")
            .patch(`/api/v1/departments/${dep.id}`)
            .send({ name: "X" })) as unknown as TestResponse
        ).status,
      ).toBe(403);

      // Unknown and forged ids are both a consistent 404.
      for (const id of [randomUUID(), f.ids.otherCompany, "not-a-uuid"]) {
        const res = (await f
          .api("admin")
          .patch(`/api/v1/departments/${id}`)
          .send({ name: "X" })) as unknown as TestResponse;
        expect(res.status, `id=${id}`).toBe(404);
      }
    } finally {
      await f.close();
    }
  });
});

describe("POST /api/v1/teams", () => {
  it("creates a team inside an existing department of the same company", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await createDepartment(f, "admin", "Vận hành");
      const team = (await f
        .api("owner")
        .post("/api/v1/teams")
        .send({ departmentId: dep.id, name: "Tổ thu hồi nợ" })) as unknown as TestResponse;
      expect(team.status).toBe(201);
      expect(team.body).toMatchObject({
        departmentId: dep.id,
        name: "Tổ thu hồi nợ",
        archivedAt: null,
      });

      const row = await f.db("team").where({ id: team.body.id }).first();
      expect(row).toMatchObject({
        company_id: f.ids.company,
        department_id: dep.id,
      });
    } finally {
      await f.close();
    }
  });

  it("rejects a team whose departmentId does not exist (404) or is not a uuid (400)", async () => {
    const f = await fixture({ seeded: true });
    try {
      const missing = (await f
        .api("admin")
        .post("/api/v1/teams")
        .send({ departmentId: randomUUID(), name: "Mồ côi" })) as unknown as TestResponse;
      expect(missing.status).toBe(404);

      const forged = (await f
        .api("admin")
        .post("/api/v1/teams")
        .send({ departmentId: f.ids.otherCompany, name: "X" })) as unknown as TestResponse;
      expect(forged.status).toBe(404);

      const malformed = (await f
        .api("admin")
        .post("/api/v1/teams")
        .send({ departmentId: "abc", name: "X" })) as unknown as TestResponse;
      expect(malformed.status).toBe(400);

      const member = (await f
        .api("member")
        .post("/api/v1/teams")
        .send({ departmentId: randomUUID(), name: "X" })) as unknown as TestResponse;
      expect(member.status).toBe(403);
    } finally {
      await f.close();
    }
  });
});

describe("PATCH /api/v1/teams/:id", () => {
  it("renames and moves a team; moving into a missing/archived department fails", async () => {
    const f = await fixture({ seeded: true });
    try {
      const depA = await createDepartment(f, "admin", "A");
      const depB = await createDepartment(f, "admin", "B");
      const team = await createTeam(f, "admin", depA.id, "T1");

      const moved = (await f
        .api("owner")
        .patch(`/api/v1/teams/${team.id}`)
        .send({ departmentId: depB.id })) as unknown as TestResponse;
      expect(moved.status).toBe(200);
      expect(moved.body).toMatchObject({ id: team.id, departmentId: depB.id });

      const renamed = (await f
        .api("admin")
        .patch(`/api/v1/teams/${team.id}`)
        .send({ name: "T1 đổi tên" })) as unknown as TestResponse;
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe("T1 đổi tên");

      const missing = (await f
        .api("admin")
        .patch(`/api/v1/teams/${team.id}`)
        .send({ departmentId: randomUUID() })) as unknown as TestResponse;
      expect(missing.status).toBe(404);

      // Moving into an archived department is a state conflict.
      const depArchived = await createDepartment(f, "admin", "Đóng");
      const arch = (await f
        .api("admin")
        .post(
          `/api/v1/departments/${depArchived.id}/archive`,
        )) as unknown as TestResponse;
      expect(arch.status).toBe(200);
      const intoArchived = (await f
        .api("admin")
        .patch(`/api/v1/teams/${team.id}`)
        .send({ departmentId: depArchived.id })) as unknown as TestResponse;
      expect(intoArchived.status).toBe(409);

      // Empty patch body and member mutation.
      const empty = (await f
        .api("admin")
        .patch(`/api/v1/teams/${team.id}`)
        .send({})) as unknown as TestResponse;
      expect(empty.status).toBe(400);
      const member = (await f
        .api("member")
        .patch(`/api/v1/teams/${team.id}`)
        .send({ name: "X" })) as unknown as TestResponse;
      expect(member.status).toBe(403);
    } finally {
      await f.close();
    }
  });

  it("refuses to move a populated team with 409 ORG_UNIT_IN_USE — transfer members first", async () => {
    const f = await fixture({ seeded: true });
    try {
      const depA = await createDepartment(f, "admin", "A");
      const depB = await createDepartment(f, "admin", "B");
      const team = await createTeam(f, "admin", depA.id, "T1");

      // A member seated in depA+team: the composite app_user_team_fk ties
      // her team to depA, so rewriting team.department_id would trip the
      // FK (ON UPDATE NO ACTION) — the service must 409 instead of 500.
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ department_id: depA.id, team_id: team.id });

      const moved = (await f
        .api("admin")
        .patch(`/api/v1/teams/${team.id}`)
        .send({ departmentId: depB.id })) as unknown as TestResponse;
      expect(moved.status).toBe(409);
      expect(moved.body.code).toBe("ORG_UNIT_IN_USE");

      // The rejected move rolled back cleanly: the team still sits under
      // depA and no org.team.update audit row was committed.
      const row = await f.db("team").where({ id: team.id }).first();
      expect(row.department_id).toBe(depA.id);
      const audit = await f
        .db("audit_event")
        .where({ action: "org.team.update", target_id: team.id })
        .first();
      expect(audit).toBeUndefined();

      // Only the move is guarded — renaming a populated team still works.
      const renamed = (await f
        .api("admin")
        .patch(`/api/v1/teams/${team.id}`)
        .send({ name: "T1 đổi tên" })) as unknown as TestResponse;
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        name: "T1 đổi tên",
        departmentId: depA.id,
      });
    } finally {
      await f.close();
    }
  });
});

describe("GET /api/v1/teams", () => {
  it("lists teams scoped to the company, filterable by departmentId", async () => {
    const f = await fixture({ seeded: true });
    try {
      const depA = await createDepartment(f, "admin", "A");
      const depB = await createDepartment(f, "admin", "B");
      await createTeam(f, "admin", depA.id, "T-A1");
      await createTeam(f, "admin", depA.id, "T-A2");
      await createTeam(f, "admin", depB.id, "T-B1");

      const all = (await f
        .api("member")
        .get("/api/v1/teams")) as unknown as TestResponse;
      expect(all.status).toBe(200);
      expect(all.body.items).toHaveLength(3);
      expect(all.body.nextCursor).toBeNull();

      const filtered = (await f
        .api("member")
        .get(
          `/api/v1/teams?departmentId=${depA.id}`,
        )) as unknown as TestResponse;
      expect(filtered.status).toBe(200);
      expect(filtered.body.items).toHaveLength(2);
      for (const t of filtered.body.items as { departmentId: string }[]) {
        expect(t.departmentId).toBe(depA.id);
      }

      const badFilter = (await f
        .api("member")
        .get("/api/v1/teams?departmentId=nope")) as unknown as TestResponse;
      expect(badFilter.status).toBe(400);
    } finally {
      await f.close();
    }
  });
});

describe("company profile (singleton — spec §3)", () => {
  it("has NO company-create endpoint: POST /api/v1/companies is an unknown route (404)", async () => {
    const f = await fixture({ seeded: true });
    try {
      // Even a fully authenticated owner gets 404 — the route does not
      // exist, this is not a permission failure.
      expect(
        (
          (await f
            .api("owner")
            .post("/api/v1/companies")
            .send({ name: "Second" })) as unknown as TestResponse
        ).status,
      ).toBe(404);
      expect(
        (
          (await f
            .api()
            .post("/api/v1/companies")
            .send({ name: "Second" })) as unknown as TestResponse
        ).status,
      ).toBe(404);
      // And the singleton stays a singleton.
      const count = await f.db("company").count("* as n").first();
      expect(count).toMatchObject({ n: "1" });
    } finally {
      await f.close();
    }
  });

  it("GET returns the profile to any persona; PATCH is owner/admin only and validates IANA timezone", async () => {
    const f = await fixture({ seeded: true });
    try {
      const before = (await f
        .api("member")
        .get("/api/v1/company")) as unknown as TestResponse;
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        id: f.ids.company,
        name: "GWP Test Company",
        timezone: "Asia/Ho_Chi_Minh",
      });

      const patched = (await f
        .api("admin")
        .patch("/api/v1/company")
        .send({ name: "GWP Đổi Tên", timezone: "Asia/Bangkok" })) as unknown as TestResponse;
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        id: f.ids.company,
        name: "GWP Đổi Tên",
        timezone: "Asia/Bangkok",
      });

      const row = await f
        .db("company")
        .where({ id: f.ids.company })
        .first();
      expect(row).toMatchObject({
        name: "GWP Đổi Tên",
        timezone: "Asia/Bangkok",
      });

      for (const bad of [
        {},
        { timezone: "Not/AZone" },
        { timezone: "Asia/Ho_Chi_Minh; DROP TABLE company" },
        { name: "X", role: "owner" },
      ]) {
        const res = (await f
          .api("admin")
          .patch("/api/v1/company")
          .send(bad)) as unknown as TestResponse;
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }

      expect(
        (
          (await f
            .api("member")
            .patch("/api/v1/company")
            .send({ name: "Member" })) as unknown as TestResponse
        ).status,
      ).toBe(403);
      expect(
        (
          (await f
            .api("manager")
            .patch("/api/v1/company")
            .send({ name: "Manager" })) as unknown as TestResponse
        ).status,
      ).toBe(403);
    } finally {
      await f.close();
    }
  });
});

describe("archive semantics (spec §3)", () => {
  it("archives an unreferenced unit: still listed with archivedAt, FKs intact, idempotent", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await createDepartment(f, "admin", "Lưu trữ");
      const team = await createTeam(f, "admin", dep.id, "Tổ cũ");

      // Order matters: a department with live teams refuses to archive —
      // archive child teams first, then the department.
      const archTeam = (await f
        .api("owner")
        .post(`/api/v1/teams/${team.id}/archive`)) as unknown as TestResponse;
      expect(archTeam.status).toBe(200);
      expect(typeof archTeam.body.archivedAt).toBe("string");

      const archDep = (await f
        .api("owner")
        .post(
          `/api/v1/departments/${dep.id}/archive`,
        )) as unknown as TestResponse;
      expect(archDep.status).toBe(200);
      expect(archDep.body.id).toBe(dep.id);
      expect(typeof archDep.body.archivedAt).toBe("string");

      // Archived rows are still listed, flagged — historical FKs survive.
      const deps = (await f
        .api("member")
        .get("/api/v1/departments")) as unknown as TestResponse;
      const found = (deps.body.items as { id: string; archivedAt: string | null }[]).find(
        (d) => d.id === dep.id,
      );
      expect(found).toBeDefined();
      expect(found!.archivedAt).not.toBeNull();
      const teamRow = await f.db("team").where({ id: team.id }).first();
      expect(teamRow.department_id).toBe(dep.id);
      expect(teamRow.archived_at).not.toBeNull();

      // Re-archiving is idempotent — already archived, not an error.
      const again = (await f
        .api("owner")
        .post(
          `/api/v1/departments/${dep.id}/archive`,
        )) as unknown as TestResponse;
      expect(again.status).toBe(200);
      expect(again.body.archivedAt).toBe(archDep.body.archivedAt);

      // A member cannot archive.
      expect(
        (
          (await f
            .api("member")
            .post(
              `/api/v1/teams/${team.id}/archive`,
            )) as unknown as TestResponse
        ).status,
      ).toBe(403);
      // Unknown unit → consistent 404.
      expect(
        (
          (await f
            .api("owner")
            .post(
              `/api/v1/teams/${randomUUID()}/archive`,
            )) as unknown as TestResponse
        ).status,
      ).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("refuses to archive a referenced unit with 409 ORG_UNIT_IN_USE — no cascade", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await createDepartment(f, "admin", "Còn người");
      const team = await createTeam(f, "admin", dep.id, "Còn người");

      // Member belongs to department+team (consistent pair — the composite
      // FK demands department_id match the team's department).
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ department_id: dep.id, team_id: team.id });

      const archDep = (await f
        .api("admin")
        .post(
          `/api/v1/departments/${dep.id}/archive`,
        )) as unknown as TestResponse;
      expect(archDep.status).toBe(409);
      expect(archDep.body.code).toBe("ORG_UNIT_IN_USE");

      const archTeam = (await f
        .api("admin")
        .post(`/api/v1/teams/${team.id}/archive`)) as unknown as TestResponse;
      expect(archTeam.status).toBe(409);
      expect(archTeam.body.code).toBe("ORG_UNIT_IN_USE");

      // Nothing was archived or deleted — rows and references intact.
      const depRow = await f.db("department").where({ id: dep.id }).first();
      expect(depRow.archived_at).toBeNull();
      const member = await f
        .db("app_user")
        .where({ id: f.ids.member })
        .first();
      expect(member).toMatchObject({
        department_id: dep.id,
        team_id: team.id,
      });
    } finally {
      await f.close();
    }
  });

  it("refuses to archive a department with live child teams — archive or move them first", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await createDepartment(f, "admin", "Còn tổ");
      const liveTeam = await createTeam(f, "admin", dep.id, "Tổ sống");
      const doneTeam = await createTeam(f, "admin", dep.id, "Tổ xong");

      // An already-archived child does not block; the live one does.
      const archDone = (await f
        .api("owner")
        .post(
          `/api/v1/teams/${doneTeam.id}/archive`,
        )) as unknown as TestResponse;
      expect(archDone.status).toBe(200);

      const blocked = (await f
        .api("admin")
        .post(
          `/api/v1/departments/${dep.id}/archive`,
        )) as unknown as TestResponse;
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("ORG_UNIT_IN_USE");

      // Nothing was archived — no half-archived tree.
      const depRow = await f.db("department").where({ id: dep.id }).first();
      expect(depRow.archived_at).toBeNull();

      // Archive the last live team — the department now archives cleanly.
      const archLive = (await f
        .api("owner")
        .post(
          `/api/v1/teams/${liveTeam.id}/archive`,
        )) as unknown as TestResponse;
      expect(archLive.status).toBe(200);
      const ok = (await f
        .api("admin")
        .post(
          `/api/v1/departments/${dep.id}/archive`,
        )) as unknown as TestResponse;
      expect(ok.status).toBe(200);
      expect(typeof ok.body.archivedAt).toBe("string");
    } finally {
      await f.close();
    }
  });

  it("rejects creating a team inside an archived department", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = await createDepartment(f, "admin", "Đã lưu trữ");
      const arch = (await f
        .api("admin")
        .post(
          `/api/v1/departments/${dep.id}/archive`,
        )) as unknown as TestResponse;
      expect(arch.status).toBe(200);

      const res = (await f
        .api("admin")
        .post("/api/v1/teams")
        .send({ departmentId: dep.id, name: "Không được" })) as unknown as TestResponse;
      expect(res.status).toBe(409);
    } finally {
      await f.close();
    }
  });
});

describe("composite integrity at the DB level (spec §3)", () => {
  it("makes a team assignment whose department does not match impossible (23503/23514)", async () => {
    const f = await fixture({ seeded: true });
    try {
      const depA = await createDepartment(f, "admin", "A");
      const depB = await createDepartment(f, "admin", "B");
      const team = await createTeam(f, "admin", depA.id, "T-A");

      // A consistent assignment succeeds.
      await f
        .db("app_user")
        .where({ id: f.ids.member })
        .update({ department_id: depA.id, team_id: team.id });
      const ok = await f.db("app_user").where({ id: f.ids.member }).first();
      expect(ok).toMatchObject({ department_id: depA.id, team_id: team.id });

      // Team in A + department B → composite FK violation.
      await expect(
        f
          .db("app_user")
          .where({ id: f.ids.member })
          .update({ department_id: depB.id }),
      ).rejects.toMatchObject({ code: "23503" });

      // Team without a department → CHECK violation.
      await expect(
        f
          .db("app_user")
          .where({ id: f.ids.outsider })
          .update({ team_id: team.id }),
      ).rejects.toMatchObject({ code: "23514" });

      // Department id that does not exist → FK violation.
      await expect(
        f
          .db("app_user")
          .where({ id: f.ids.outsider })
          .update({ department_id: randomUUID() }),
      ).rejects.toMatchObject({ code: "23503" });

      // A team cannot point at a department that does not exist.
      await expect(
        f.db("team").insert({
          company_id: f.ids.company,
          department_id: randomUUID(),
          name: "Orphan",
        }),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await f.close();
    }
  });
});

describe("audit (spec §9)", () => {
  it("every org mutation appends an audit row with the real actor + request id", async () => {
    const f = await fixture({ seeded: true });
    try {
      const dep = (await f
        .api("admin")
        .post("/api/v1/departments")
        .send({ name: "Audit" })) as unknown as TestResponse;
      expect(dep.status).toBe(201);
      const requestId = dep.headers["x-request-id"];

      const created = await f
        .db("audit_event")
        .where({ action: "org.department.create", request_id: requestId })
        .first();
      expect(created).toMatchObject({
        company_id: f.ids.company,
        actor_id: f.ids.admin, // real actor, not the target
        target_type: "department",
        target_id: dep.body.id,
        outcome: "success",
      });

      const arch = (await f
        .api("owner")
        .post(
          `/api/v1/departments/${dep.body.id}/archive`,
        )) as unknown as TestResponse;
      const archived = await f
        .db("audit_event")
        .where({
          action: "org.department.archive",
          request_id: arch.headers["x-request-id"],
        })
        .first();
      expect(archived).toMatchObject({
        actor_id: f.ids.owner,
        outcome: "success",
      });

      const patched = (await f
        .api("admin")
        .patch("/api/v1/company")
        .send({ name: "Audit Co" })) as unknown as TestResponse;
      const companyAudit = await f
        .db("audit_event")
        .where({
          action: "org.company.update",
          request_id: patched.headers["x-request-id"],
        })
        .first();
      expect(companyAudit).toMatchObject({
        actor_id: f.ids.admin,
        target_type: "company",
        outcome: "success",
      });
    } finally {
      await f.close();
    }
  });
});

describe("deactivated-actor gate (TOCTOU regression)", () => {
  it("an admin deactivated mid-flight cannot complete an org mutation — 403 FORBIDDEN", async () => {
    const f = await fixture({ seeded: true });
    try {
      const org = createOrgService({ db: f.db, clock: () => new Date() });
      // Control: the privileged actor passes while still active.
      await org.createDepartment(f.actor("admin"), { name: "Trước" });

      // Role rows survive deactivation — only status flips. This is the
      // residual window authenticate() cannot cover: the request was
      // already authenticated when the deactivation committed.
      await f
        .db("app_user")
        .where({ id: f.ids.admin })
        .update({ status: "inactive" });

      await expect(
        org.createDepartment(f.actor("admin"), { name: "Sau" }),
      ).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
        message: "Tài khoản không hoạt động",
      });
    } finally {
      await f.close();
    }
  });
});
