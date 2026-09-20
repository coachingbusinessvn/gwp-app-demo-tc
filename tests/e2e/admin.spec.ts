import { expect, test } from "@playwright/test";
import { apiAsPage, isolateClientIp, loginAs } from "../helpers/browser.js";

/**
 * Task 1.5 e2e — the real admin surface against the seeded gwp_e2e DB.
 *
 * Covered: admin reaches admin.html but owner-only controls (role grant,
 * credential tokens, reporting line) are NOT rendered; the API stays
 * authoritative (a direct admin roles call still 403s); a department is
 * created through the real form; the full pending-user → owner-issued
 * activation token → activate.html → real login chain works end to end;
 * branding displayName carrying HTML is rendered as inert text; and the
 * audit tab shows metadata-only rows.
 */

interface UserItem {
  id: string;
  email: string;
  name: string;
  status: string;
  roles: string[];
}

test("admin quản trị được org nhưng không thấy nút đặc quyền — API vẫn 403", async ({
  page,
}) => {
  await loginAs(page, "admin");
  await page.goto("/admin.html");
  await expect(page.getByTestId("account-name")).toContainText(
    "Fixture Admin",
  );

  // Owner-only controls are absent from the DOM for admin — not merely
  // disabled (spec §4: cấp quyền/mã xác thực/tuyến báo cáo là owner-only).
  await expect(
    page.getByRole("button", { name: "Cấp quyền owner" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Phát mã/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Đổi cấp trên" }),
  ).toHaveCount(0);

  // Org config IS allowed: create a department through the real form.
  await page.getByRole("button", { name: "Tạo phòng ban" }).click();
  await page.getByLabel("Tên phòng ban").fill("Khối mới");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByText("Khối mới", { exact: true })).toBeVisible();

  // The UI hiding is convenience only — the API is authoritative: a
  // direct PUT /users/:id/roles as admin is still 403.
  const list = await apiAsPage(page, "GET", "/users?limit=100");
  expect(list.status).toBe(200);
  const member = (list.body as { items: UserItem[] }).items.find(
    (u) => u.email === "member@example.test",
  );
  expect(member).toBeDefined();
  const denied = await apiAsPage(page, "PUT", `/users/${member!.id}/roles`, {
    roles: ["member", "admin"],
  });
  expect(denied.status).toBe(403);
  // Same for credential-token issuance — owner only.
  const deniedToken = await apiAsPage(
    page,
    "POST",
    `/users/${member!.id}/credential-token`,
    { purpose: "reset" },
  );
  expect(deniedToken.status).toBe(403);
});

test("vòng đời tài khoản: admin tạo pending → owner phát mã → activate → login", async ({
  page,
  browser,
}) => {
  const email = "newbie@example.test";
  const password = "mat-khau-moi-12345";

  // Admin creates the pending member through the real admin form.
  await loginAs(page, "admin");
  await page.goto("/admin.html");
  await page.getByRole("tab", { name: "Người dùng" }).click();
  await page.getByRole("button", { name: "Tạo người dùng" }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Họ tên").fill("Người Mới");
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();

  // Owner session in an ISOLATED context — a second page in the same
  // context would share the refresh-cookie slot, and index.html would
  // auto-redirect the existing session to the shell instead of showing
  // the login form. The admin page keeps working on its in-memory token.
  const origin = new URL(page.url()).origin;
  const ownerCtx = await browser.newContext({ baseURL: origin });
  const publicCtx = await browser.newContext({ baseURL: origin });
  await isolateClientIp(publicCtx);
  try {
    const ownerPage = await ownerCtx.newPage();
    await loginAs(ownerPage, "owner");
    await ownerPage.goto("/admin.html");
    await ownerPage.getByRole("tab", { name: "Người dùng" }).click();
    // The owner DOES see the owner-only controls admin did not.
    await expect(
      ownerPage.getByRole("button", { name: "Cấp quyền owner" }).first(),
    ).toBeVisible();

    const list = await apiAsPage(ownerPage, "GET", "/users?limit=100");
    const created = (list.body as { items: UserItem[] }).items.find(
      (u) => u.email === email,
    );
    expect(created).toBeDefined();
    expect(created!.status).toBe("pending");

    const issued = await apiAsPage(
      ownerPage,
      "POST",
      `/users/${created!.id}/credential-token`,
      { purpose: "activate" },
    );
    expect(issued.status).toBe(201);
    const token = (issued.body as { token: string }).token;

    // The consume page is public: the owner hands the ?token= link over
    // an internal channel. A fresh context proves no session is needed.
    const activation = await publicCtx.newPage();
    await activation.goto(
      `/activate.html?token=${encodeURIComponent(token)}`,
    );
    await activation.getByLabel("Mật khẩu mới").fill(password);
    await activation.getByLabel("Nhập lại mật khẩu").fill(password);
    await activation
      .getByRole("button", { name: "Kích hoạt tài khoản" })
      .click();
    await expect(
      activation.getByRole("link", { name: "Đăng nhập" }),
    ).toBeVisible();

    // Then a REAL login with the brand-new password → account shell.
    await activation.getByRole("link", { name: "Đăng nhập" }).click();
    await expect(activation).toHaveURL(/\/index\.html$/);
    await activation.getByLabel("Email").fill(email);
    await activation
      .getByLabel("Mật khẩu", { exact: true })
      .fill(password);
    await activation
      .getByRole("button", { name: "Đăng nhập", exact: true })
      .click();
    await expect(activation).toHaveURL(/\/dashboard\.html$/);
    await expect(activation.getByTestId("account-name")).toContainText(
      "Người Mới",
    );
  } finally {
    await ownerCtx.close();
    await publicCtx.close();
  }
});

test("branding displayName chứa HTML được render như text thuần", async ({
  page,
}) => {
  const payload = {
    displayName: '<img src=x onerror=alert(1)>',
    accentColor: "#1A2b3C",
  };
  await loginAs(page, "owner");
  const saved = await apiAsPage(page, "PATCH", "/settings/branding", payload);
  expect(saved.status).toBe(200);

  await page.goto("/admin.html");
  // The stored string appears verbatim as text — never as markup.
  await expect(
    page.getByText(payload.displayName, { exact: true }),
  ).toBeVisible();
  await expect(page.locator("img[onerror]")).toHaveCount(0);

  // accentColor is applied as a validated CSS value on the swatch.
  await expect(page.getByTestId("brand-accent")).toHaveCSS(
    "background-color",
    "rgb(26, 43, 60)",
  );
});

test("nhật ký audit: owner/admin xem được bản metadata-only", async ({
  page,
}) => {
  await loginAs(page, "admin");
  // Produce one audited event first so the listing is non-empty and known.
  const created = await apiAsPage(page, "POST", "/departments", {
    name: "Khối audit",
  });
  expect(created.status).toBe(201);

  await page.goto("/admin.html");
  await page.getByRole("tab", { name: "Nhật ký" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Hành động" }),
  ).toBeVisible();
  await expect(
    page.getByText("org.department.create", { exact: true }).first(),
  ).toBeVisible();
});
