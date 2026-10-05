import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { apiAsPage, isolateClientIp, loginAs } from "../helpers/browser.js";

/**
 * Account self-service + the shared app shell (web/shell.js, account.html).
 *
 * Covered: every signed-in page carries the same shell — Canvas Online +
 * Coaching Report nav, account name → account.html, logout, "Quản trị"
 * only for owner/admin — including the hero-header pages (canvas-online/,
 * coaching-report/); company branding reaches non-admin pages; a brand-new
 * member edits their own name/title and changes their password, and the
 * revoked session is handled by a clean re-login (old password dead, other
 * sessions dead, new password works); the login page shows the
 * forgot-password hint; dashboard/employee show loading states and tell a
 * load failure apart from "not in your scope".
 *
 * The password flow runs on a fresh per-run account — fixture personas keep
 * FIXTURE_PASSWORD for every other spec (the e2e DB persists between runs).
 */

interface UserItem {
  id: string;
  email: string;
}

async function loginWith(page: Page, email: string, password: string) {
  await page.goto("/index.html");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
}

test("trang đăng nhập có gợi ý quên mật khẩu", async ({ page }) => {
  await isolateClientIp(page);
  await page.goto("/index.html");
  await expect(page.getByTestId("forgot-password-hint")).toHaveText(
    "Quên mật khẩu? Liên hệ owner/quản trị để nhận mã đặt lại.",
  );
});

test("shell chung: nav Canvas Online, tên tài khoản → account.html, đăng xuất trên mọi trang", async ({
  page,
  browser,
}) => {
  await loginAs(page, "member");
  // Compact shell (assets/app.js → web/shell.js).
  await expect(
    page.locator('nav.sitenav a[href="/canvas-online/"]'),
  ).toHaveText("Canvas Online");
  await expect(
    page.locator('nav.sitenav a[href="/coaching-report/"]'),
  ).toHaveText("Coaching Report");
  await expect(page.getByTestId("account-name")).toHaveAttribute(
    "href",
    "/account.html",
  );
  await expect(page.getByRole("link", { name: "Quản trị" })).toHaveCount(0);

  // Hero-header pages self-mount the same capabilities.
  for (const path of ["/canvas-online/", "/coaching-report/"]) {
    await page.goto(path);
    const account = page.getByTestId("account-name");
    await expect(account, path).toContainText("Fixture Member");
    await expect(account, path).toHaveAttribute("href", "/account.html");
    await expect(
      page.getByRole("link", { name: "Đăng xuất" }),
      path,
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Quản trị" }), path).toHaveCount(0);
  }

  // Account link lands on the self-service page.
  await page.getByTestId("account-name").click();
  await expect(page).toHaveURL(/\/account\.html$/);
  await expect(page.getByTestId("account-email")).toHaveText(
    "member@example.test",
  );

  // Logout from a hero-header page ends the session.
  await page.goto("/coaching-report/");
  await page.getByRole("link", { name: "Đăng xuất" }).click();
  await expect(page).toHaveURL(/\/index\.html$/);
  await page.goto("/dashboard.html");
  await expect(page).toHaveURL(/\/index\.html$/);

  // Owner sees "Quản trị" on the hero-header pages too.
  const ownerCtx = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const ownerPage = await ownerCtx.newPage();
    await loginAs(ownerPage, "owner");
    await ownerPage.goto("/canvas-online/");
    await expect(
      ownerPage.getByRole("link", { name: "Quản trị" }),
    ).toBeVisible();
  } finally {
    await ownerCtx.close();
  }
});

test("branding công ty hiển thị trên các trang không phải admin", async ({
  page,
}) => {
  await loginAs(page, "owner");
  const before = await apiAsPage(page, "GET", "/settings/branding");
  expect(before.status).toBe(200);
  const name = `Công ty Thử ${Date.now()}`;
  try {
    const saved = await apiAsPage(page, "PATCH", "/settings/branding", {
      displayName: name,
      accentColor: "#1A2B3C",
    });
    expect(saved.status).toBe(200);

    await page.goto("/dashboard.html");
    await expect(page.locator("header.app [data-brand-name]")).toHaveText(name);
    await expect(page.locator("footer.app [data-brand-name]")).toHaveText(name);
    await expect(page).toHaveTitle(new RegExp(`\\| ${name}$`));

    await page.goto("/canvas-online/");
    await expect(page.locator("header.app [data-brand-name]")).toHaveText(name);
    await expect(page.locator("footer.app > b").first()).toHaveText(name);

    await page.goto("/coaching-report/");
    await expect(page.locator("header.app [data-brand-name]")).toHaveText(name);
  } finally {
    // Shared e2e DB — put the previous branding back for other specs.
    await apiAsPage(page, "PATCH", "/settings/branding", before.body);
  }
});

test("tự phục vụ: sửa họ tên/chức danh, đổi mật khẩu → mọi phiên kết thúc, đăng nhập lại", async ({
  page,
  browser,
}) => {
  const email = `self-${Date.now()}@example.test`;
  const firstPassword = "mat-khau-dau-tien-123";
  const newPassword = "mat-khau-moi-sau-doi-456";

  // Owner provisions + activates a throwaway member through the real API.
  await loginAs(page, "owner");
  const origin = new URL(page.url()).origin;
  const created = await apiAsPage(page, "POST", "/users", {
    email,
    name: "Người Tự Phục Vụ",
  });
  expect(created.status).toBe(201);
  const userId = (created.body as UserItem).id;
  const issued = await apiAsPage(
    page,
    "POST",
    `/users/${userId}/credential-token`,
    { purpose: "activate" },
  );
  expect(issued.status).toBe(201);
  const activated = await page.request.post("/api/v1/auth/activate", {
    data: { token: (issued.body as { token: string }).token, password: firstPassword },
  });
  expect(activated.status()).toBe(204);

  const userCtx = await browser.newContext({ baseURL: origin });
  const otherCtx = await browser.newContext({ baseURL: origin });
  await isolateClientIp(userCtx);
  await isolateClientIp(otherCtx);
  try {
    // A second, independent session of the same user (another device).
    const other = await otherCtx.newPage();
    await loginWith(other, email, firstPassword);
    await expect(other).toHaveURL(/\/dashboard\.html$/);

    const me = await userCtx.newPage();
    await loginWith(me, email, firstPassword);
    await expect(me).toHaveURL(/\/dashboard\.html$/);
    await me.getByTestId("account-name").click();
    await expect(me).toHaveURL(/\/account\.html$/);
    await expect(me.getByTestId("account-email")).toHaveText(email);
    await expect(me.getByText("Thành viên", { exact: true })).toBeVisible();

    // --- Profile: own name/title only. ---
    await me.getByLabel("Họ tên").fill("Người Đã Đổi Tên");
    await me.getByLabel("Chức danh").fill("Chuyên viên phân tích");
    await me.getByRole("button", { name: "Lưu thông tin" }).click();
    await expect(me.getByText("Đã lưu thông tin.")).toBeVisible();
    await expect(me.getByTestId("account-name")).toContainText("Người Đã Đổi Tên");
    await me.reload();
    await expect(me.getByLabel("Họ tên")).toHaveValue("Người Đã Đổi Tên");
    await expect(me.getByLabel("Chức danh")).toHaveValue("Chuyên viên phân tích");

    // --- Password: client checks, then the server's wrong-current 400. ---
    const current = me.getByLabel("Mật khẩu hiện tại");
    const next = me.getByLabel("Mật khẩu mới", { exact: true });
    const confirm = me.getByLabel("Nhập lại mật khẩu mới");
    const submit = me.getByRole("button", { name: "Đổi mật khẩu" });

    await current.fill(firstPassword);
    await next.fill("ngan");
    await confirm.fill("ngan");
    await submit.click();
    await expect(me.locator("#passwordErr")).toContainText("tối thiểu 12");

    await next.fill(newPassword);
    await confirm.fill(newPassword + "x");
    await submit.click();
    await expect(me.locator("#passwordErr")).toHaveText(
      "Mật khẩu nhập lại không khớp.",
    );

    await current.fill("sai-mat-khau-hien-tai");
    await confirm.fill(newPassword);
    await submit.click();
    await expect(me.locator("#passwordErr")).toHaveText(
      "Mật khẩu hiện tại không đúng.",
    );
    await expect(me).toHaveURL(/\/account\.html$/);

    // Success → this session is revoked → login page with the notice.
    await current.fill(firstPassword);
    await next.fill(newPassword);
    await confirm.fill(newPassword);
    await submit.click();
    await expect(me).toHaveURL(/\/index\.html$/);
    await expect(me.getByRole("status")).toContainText("Mật khẩu đã đổi");

    // The other device's session died with it (server-side revoke).
    await other.goto("/dashboard.html");
    await expect(other).toHaveURL(/\/index\.html$/);

    // Old password is dead; the new one works.
    await loginWith(me, email, firstPassword);
    await expect(me.getByRole("alert")).toContainText(
      "Email hoặc mật khẩu không đúng",
    );
    await loginWith(me, email, newPassword);
    await expect(me).toHaveURL(/\/dashboard\.html$/);
    await expect(me.getByTestId("account-name")).toContainText(
      "Người Đã Đổi Tên",
    );
  } finally {
    await userCtx.close();
    await otherCtx.close();
  }
});

test("dashboard hiện trạng thái đang tải cho tới khi dữ liệu về", async ({
  page,
}) => {
  await loginAs(page, "manager");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/v1/dashboard", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/dashboard.html");
  await expect(page.locator("#attention .loading")).toHaveText("Đang tải…");
  await expect(page.locator("#attention")).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.locator("#attention .loading")).toHaveCount(0);
  await expect(page.locator("#attention")).toContainText("Cần bạn xử lý");
});

test("employee: lỗi tải dữ liệu khác với 'ngoài phạm vi'", async ({ page }) => {
  await loginAs(page, "member");

  // Out of scope: a real dashboard answer that simply lacks the person.
  await page.goto(`/employee.html?id=${randomUUID()}`);
  await expect(
    page.getByRole("heading", { name: "Không xem được hồ sơ này" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Thử lại" })).toHaveCount(0);

  // Load failure: the dashboard read never arrives → retry, not "denied".
  await page.route("**/api/v1/dashboard", (route) => route.abort());
  await page.goto(`/employee.html?id=${randomUUID()}`);
  await expect(
    page.getByRole("heading", { name: "Không tải được dữ liệu" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Không kết nối được máy chủ");
  await expect(page.getByRole("button", { name: "Thử lại" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Không xem được hồ sơ này" }),
  ).toHaveCount(0);
});
