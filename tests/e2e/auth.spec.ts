import { expect, test, type Page } from "@playwright/test";

/**
 * Task 0.5 e2e — real web auth against the real backend (dedicated gwp_e2e
 * DB seeded with the five fixture personas by tests/e2e/serve.ts → e2e-db.ts).
 *
 * Covered: real form login → account shell, real 401 error (no demo
 * fallback), cross-tab session sharing via the HttpOnly cookie, concurrent
 * tab refresh without false revocation (single-flight via navigator.locks +
 * BroadcastChannel), zero tokens in localStorage, and the production bundle
 * never requesting demo-era assets.
 */

const PERSONA = {
  member: { email: "member@example.test", password: "fixture-password" },
  manager: { email: "manager@example.test", password: "fixture-password" },
  owner: { email: "owner@example.test", password: "fixture-password" },
} as const;

async function loginViaUi(
  page: Page,
  creds: { email: string; password: string },
): Promise<void> {
  await page.goto("/index.html");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
}

async function localStorageKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage));
}

test("đăng nhập qua form thật vào được account shell", async ({ page }) => {
  await loginViaUi(page, PERSONA.member);
  await expect(page).toHaveURL(/\/dashboard\.html$/);
  await expect(page.getByTestId("account-name")).toBeVisible();
  await expect(page.getByTestId("account-name")).toContainText("Fixture Member");
  // No demo session, no tokens in localStorage — access token lives in
  // memory only; refresh token only in the HttpOnly cookie (spec §8).
  const keys = await localStorageKeys(page);
  expect(keys).not.toContain("gwp-demo-tc-session");
  expect(keys.filter((k) => /token|gwp/i.test(k))).toEqual([]);
});

test("sai mật khẩu hiển thị lỗi thật — không fallback về demo auth", async ({
  page,
}) => {
  await page.goto("/index.html");
  await page.getByLabel("Email").fill(PERSONA.member.email);
  await page
    .getByLabel("Mật khẩu", { exact: true })
    .fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  // Server's real 401 envelope message — not a fabricated client-side error.
  await expect(page.getByRole("alert")).toContainText(
    "Email hoặc mật khẩu không đúng",
  );
  await expect(page).toHaveURL(/\/index\.html$/);
  expect(await localStorageKeys(page)).toEqual([]);
});

test("tab thứ hai dùng chung session cookie — không phải đăng nhập lại", async ({
  page,
  context,
}) => {
  await loginViaUi(page, PERSONA.manager);
  await expect(page.getByTestId("account-name")).toBeVisible();

  // New tab: zero in-memory token, so requireAuth() must refresh via the
  // shared HttpOnly cookie — proves the session cookie is shared per-context.
  const tab2 = await context.newPage();
  await tab2.goto("/dashboard.html");
  await expect(tab2.getByTestId("account-name")).toBeVisible();
  await expect(tab2.getByTestId("account-name")).toContainText(
    "Fixture Manager",
  );
});

test("refresh đồng thời giữa các tab không revoke nhầm (single-flight)", async ({
  page,
  context,
}) => {
  await loginViaUi(page, PERSONA.owner);
  await expect(page.getByTestId("account-name")).toBeVisible();

  const tab2 = await context.newPage();
  const tab3 = await context.newPage();

  // Three tabs, three empty in-memory token slots → three concurrent refresh
  // attempts on the same rotating cookie. Without cross-tab single-flight
  // the loser would present a consumed token and revoke the whole family.
  await Promise.all([
    page.reload(),
    tab2.goto("/dashboard.html"),
    tab3.goto("/employee.html"),
  ]);
  await expect(page.getByTestId("account-name")).toBeVisible();
  await expect(tab2.getByTestId("account-name")).toBeVisible();
  await expect(tab3.getByTestId("account-name")).toBeVisible();

  // Once more — a false revocation above would surface here as a redirect
  // back to the login page on the next refresh.
  await Promise.all([page.reload(), tab2.reload(), tab3.reload()]);
  await expect(page.getByTestId("account-name")).toBeVisible();
  await expect(tab2.getByTestId("account-name")).toBeVisible();
  await expect(tab3.getByTestId("account-name")).toBeVisible();
  await expect(page).toHaveURL(/dashboard\.html$/);
});

test("bundle production không tải assets/data.js và trang không link mini-app demo", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (req) => requested.push(req.url()));

  await loginViaUi(page, PERSONA.member);
  await expect(page.getByTestId("account-name")).toBeVisible();
  await page.goto("/employee.html");
  await expect(page.getByTestId("account-name")).toBeVisible();
  await page.goto("/canvas.html");
  await expect(page.getByTestId("account-name")).toBeVisible();

  const demoAssets = requested.filter((u) =>
    /\/assets\/(data|export)\.js(\?|$)/.test(u),
  );
  expect(demoAssets).toEqual([]);
  for (const gone of ["canvas-online", "coaching-report"]) {
    await expect(page.locator(`a[href*="${gone}"]`)).toHaveCount(0);
  }
});
