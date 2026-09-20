import { describe, expect, it } from "vitest";
import { createSettingsService } from "../../server/src/modules/settings/service.js";
import { fixture } from "../helpers/fixture.js";

/**
 * Task 1.5 — /api/v1/settings/branding (spec §4/§9, controller ruling).
 *
 * GET is open to any authenticated member (branding personalizes the
 * shell); PATCH is owner/admin only. The strict schema is the whole
 * safety boundary: {displayName: 1-120 chars, accentColor: #rrggbb} —
 * there is deliberately NO field that could carry a URL, HTML payload or
 * CSS text. A displayName containing markup is stored verbatim (it is
 * just text); render safety is the client's job (textContent only).
 */
type TestResponse = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};

describe("GET /api/v1/settings/branding", () => {
  it("any active member can read it; defaults before first save; 401 anonymous", async () => {
    const f = await fixture({ seeded: true });
    try {
      const member = (await f
        .api("member")
        .get("/api/v1/settings/branding")) as unknown as TestResponse;
      expect(member.status).toBe(200);
      expect(member.body).toEqual({
        displayName: "GoWise Partners",
        accentColor: "#C9A668",
      });

      const outsider = (await f
        .api("outsider")
        .get("/api/v1/settings/branding")) as unknown as TestResponse;
      expect(outsider.status).toBe(200);

      const anon = (await f
        .api()
        .get("/api/v1/settings/branding")) as unknown as TestResponse;
      expect(anon.status).toBe(401);
      expect(anon.body.code).toBe("INVALID_SESSION");
    } finally {
      await f.close();
    }
  });
});

describe("PATCH /api/v1/settings/branding", () => {
  it("owner and admin can save; member and manager get 403", async () => {
    const f = await fixture({ seeded: true });
    try {
      const body = { displayName: "GWP Chi nhánh Đà Nẵng", accentColor: "#0f4C81" };

      const byMember = (await f
        .api("member")
        .patch("/api/v1/settings/branding")
        .send(body)) as unknown as TestResponse;
      expect(byMember.status).toBe(403);

      const byManager = (await f
        .api("manager")
        .patch("/api/v1/settings/branding")
        .send(body)) as unknown as TestResponse;
      expect(byManager.status).toBe(403);

      const byAdmin = (await f
        .api("admin")
        .patch("/api/v1/settings/branding")
        .send(body)) as unknown as TestResponse;
      expect(byAdmin.status).toBe(200);
      expect(byAdmin.body).toEqual(body);

      const read = (await f
        .api("member")
        .get("/api/v1/settings/branding")) as unknown as TestResponse;
      expect(read.body).toEqual(body);
    } finally {
      await f.close();
    }
  });

  it("strict schema: bad colors, empty/long names and extra keys are 400", async () => {
    const f = await fixture({ seeded: true });
    try {
      const bad = [
        { displayName: "", accentColor: "#123456" },
        { displayName: "  ", accentColor: "#123456" },
        { displayName: "x".repeat(121), accentColor: "#123456" },
        { displayName: "X", accentColor: "red" },
        { displayName: "X", accentColor: "#12345" }, // 5 digits
        { displayName: "X", accentColor: "#1234567" }, // 7 digits
        { displayName: "X", accentColor: "#12345g" }, // non-hex
        { displayName: "X", accentColor: "#123456", url: "https://evil" },
        { displayName: "X" }, // accentColor required — full replace
        { accentColor: "#123456" }, // displayName required
      ];
      for (const payload of bad) {
        const res = (await f
          .api("owner")
          .patch("/api/v1/settings/branding")
          .send(payload)) as unknown as TestResponse;
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("INVALID_INPUT");
      }
      // Nothing was persisted by the rejected payloads.
      const read = (await f
        .api("owner")
        .get("/api/v1/settings/branding")) as unknown as TestResponse;
      expect(read.body).toEqual({
        displayName: "GoWise Partners",
        accentColor: "#C9A668",
      });
    } finally {
      await f.close();
    }
  });

  it("stores a markup-carrying displayName verbatim and audits metadata only", async () => {
    const f = await fixture({ seeded: true });
    try {
      const payload = {
        displayName: '<img src=x onerror=alert(1)>',
        accentColor: "#A0B1C2",
      };
      const saved = (await f
        .api("owner")
        .patch("/api/v1/settings/branding")
        .send(payload)) as unknown as TestResponse;
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual(payload);

      const read = (await f
        .api("member")
        .get("/api/v1/settings/branding")) as unknown as TestResponse;
      expect(read.body).toEqual(payload); // verbatim — rendering escapes

      // The audit row exists but carries ONLY the allowlisted key name —
      // never the stored value (spec §9: no values in audit metadata).
      const audit = await f
        .db("audit_event")
        .where({ company_id: f.ids.company, action: "settings.branding.update" })
        .first();
      expect(audit).toBeDefined();
      expect(audit.actor_id).toBe(f.ids.owner);
      expect(audit.safe_metadata).toEqual({ key: "branding" });
    } finally {
      await f.close();
    }
  });

  it("an admin deactivated mid-flight cannot save branding — 403 FORBIDDEN (service level)", async () => {
    const f = await fixture({ seeded: true });
    try {
      const settings = createSettingsService({
        db: f.db,
        clock: () => new Date(),
      });
      // Control: the privileged actor passes while still active.
      await settings.updateBranding(f.actor("admin"), {
        displayName: "Trước",
        accentColor: "#0f4C81",
      });

      // Role rows survive deactivation — only status flips, so the role
      // check alone would still pass. authenticate() blocks NEW requests;
      // the in-flight service call is the residual window.
      await f
        .db("app_user")
        .where({ id: f.ids.admin })
        .update({ status: "inactive" });

      await expect(
        settings.updateBranding(f.actor("admin"), {
          displayName: "Sau",
          accentColor: "#123456",
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
        message: "Tài khoản không hoạt động",
      });

      // The rejected write rolled back — the control document survives.
      const read = await settings.getBranding(f.actor("admin"));
      expect(read).toEqual({
        displayName: "Trước",
        accentColor: "#0f4C81",
      });
    } finally {
      await f.close();
    }
  });
});
