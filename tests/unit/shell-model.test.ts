import { describe, expect, it } from "vitest";
import {
  brandedTitle,
  passwordChangeError,
  profilePatch,
  safeBranding,
  shellNav,
} from "../../web/shell-model.js";

/**
 * Shared app shell + account self-service helpers (web/shell-model.js):
 * the nav every signed-in page shows, branding sanitization (same #rrggbb
 * rule as the server schema — never raw CSS), and the client-side mirrors
 * of the PATCH /users/:id and POST /auth/password schemas.
 */

describe("shellNav", () => {
  it("member sees dashboard / Canvas Online / Coaching Report, no admin", () => {
    const nav = shellNav(["member"]);
    expect(nav.map((i) => i.href)).toEqual([
      "/dashboard.html",
      "/canvas-online/",
      "/coaching-report/",
    ]);
    expect(nav.some((i) => i.label === "Quản trị")).toBe(false);
  });

  it.each([["owner"], ["admin"]])("%s also gets the Quản trị entry", (role) => {
    const nav = shellNav(["member", role]);
    expect(nav.at(-1)).toMatchObject({ href: "/admin.html", label: "Quản trị" });
  });

  it("marks only the current page", () => {
    const nav = shellNav([], "canvas");
    expect(nav.filter((i) => i.current).map((i) => i.key)).toEqual(["canvas"]);
  });

  it("tolerates a missing roles array", () => {
    expect(shellNav(undefined)).toHaveLength(3);
  });
});

describe("safeBranding", () => {
  it("keeps text name + a strict #rrggbb accent", () => {
    expect(
      safeBranding({ displayName: " ACME ", accentColor: "#1A2b3C" }),
    ).toEqual({ displayName: "ACME", accentColor: "#1A2b3C" });
  });

  it("drops a non-hex accent instead of applying it as CSS", () => {
    expect(
      safeBranding({
        displayName: "ACME",
        accentColor: "red;background:url(x)",
      }),
    ).toEqual({ displayName: "ACME", accentColor: null });
  });

  it("returns null for nothing usable", () => {
    expect(safeBranding(null)).toBeNull();
    expect(safeBranding({ displayName: "  ", accentColor: "#12" })).toBeNull();
  });
});

describe("brandedTitle", () => {
  it("swaps the shipped brand suffix only", () => {
    expect(
      brandedTitle("Tài khoản — Performance Follow-up | GoWise Partners", "ACME"),
    ).toBe("Tài khoản — Performance Follow-up | ACME");
    expect(brandedTitle("Khác", "ACME")).toBe("Khác");
  });
});

describe("profilePatch", () => {
  const me = { name: "An Nguyễn", title: "Trưởng nhóm" };

  it("sends only changed, trimmed fields", () => {
    expect(profilePatch(me, "  An Trần ", "Trưởng nhóm")).toEqual({
      patch: { name: "An Trần" },
    });
  });

  it("clears an emptied title with null (server title is min 1)", () => {
    expect(profilePatch(me, "An Nguyễn", "   ")).toEqual({
      patch: { title: null },
    });
  });

  it("reports no-op and rejects an empty name", () => {
    expect(profilePatch(me, "An Nguyễn", "Trưởng nhóm")).toEqual({ patch: null });
    expect(profilePatch(me, "  ", "x").error).toMatch(/Họ tên/);
    expect(profilePatch(me, "a".repeat(201), "").error).toMatch(/200/);
  });
});

describe("passwordChangeError", () => {
  const ok = "mat-khau-moi-12345";

  it("accepts a valid change", () => {
    expect(passwordChangeError("old-password", ok, ok)).toBeNull();
  });

  it("mirrors the server min-12 rule and checks the confirmation", () => {
    expect(passwordChangeError("", ok, ok)).toMatch(/hiện tại/);
    expect(passwordChangeError("old", "short", "short")).toMatch(/12/);
    expect(passwordChangeError("old", ok, ok + "x")).toMatch(/không khớp/);
    expect(passwordChangeError(ok, ok, ok)).toMatch(/khác/);
    expect(passwordChangeError("old", "x".repeat(257), "x".repeat(257))).toMatch(/256/);
  });
});
