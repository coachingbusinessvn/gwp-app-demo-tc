import { expect, test, type Page } from "@playwright/test";
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

  // Entry point: the shared shell nav surfaces "Quản trị" for admin
  // (built by assets/app.js on every shell page; UX-only — the API is
  // still the enforcement, proven by the 403s above).
  await page.goto("/dashboard.html");
  const adminNav = page.getByRole("link", { name: "Quản trị" });
  await expect(adminNav).toBeVisible();
  await adminNav.click();
  await expect(page).toHaveURL(/\/admin\.html$/);
});

test("vòng đời tài khoản: admin tạo pending → owner phát mã → activate → login", async ({
  page,
  browser,
}) => {
  // Unique per run: playwright may reuse a live e2e server whose DB still
  // holds a previously activated account under a fixed email.
  const email = `newbie-${Date.now()}@example.test`;
  const password = "mat-khau-moi-12345";

  // Admin creates the pending member through the real admin form.
  await loginAs(page, "admin");
  await page.goto("/admin.html");
  await page.getByRole("tab", { name: "Người dùng" }).click();
  await page.getByRole("button", { name: "Tạo người dùng" }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Họ tên").fill("Người Mới");
  // Picking a department rebuilds the team <select>'s options in place —
  // the label for/select id wiring must survive, or getByLabel("Tổ")
  // would dangle.
  await page.getByLabel("Phòng ban", { exact: true }).selectOption({ index: 1 });
  await expect(page.getByLabel("Tổ", { exact: true })).toBeVisible();
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
    // A plain member's shell nav does NOT show the "Quản trị" entry.
    await expect(
      activation.getByRole("link", { name: "Quản trị" }),
    ).toHaveCount(0);
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

/* ---------- Admin completeness: reactivation, confirms, search, settings ---------- */

/** Create a pending member through the real API as the page's persona. */
async function createPending(
  page: Page,
  label: string,
): Promise<{ id: string; email: string; name: string }> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const email = `${label}-${stamp}@example.test`;
  const name = `E2E ${label} ${stamp}`;
  const res = await apiAsPage(page, "POST", "/users", { email, name });
  expect(res.status).toBe(201);
  return { id: (res.body as { id: string }).id, email, name };
}

test("ngừng hoạt động hỏi xác nhận (nêu tên + hệ quả) → kích hoạt lại; tìm kiếm lọc theo email", async ({
  page,
}) => {
  await loginAs(page, "owner");
  const target = await createPending(page, "reactivate");

  await page.goto("/admin.html");
  await page.getByRole("tab", { name: "Người dùng" }).click();

  // Client-side search: only the matching row stays.
  await page.getByLabel("Tìm người dùng").fill(target.email);
  const row = page.locator("#panel-users tbody tr", { hasText: target.email });
  await expect(row).toHaveCount(1);
  await expect(
    page.locator("#panel-users tbody tr", { hasText: "member@example.test" }),
  ).toHaveCount(0);
  await expect(page.getByText(/^Hiển thị 1 \/ \d+ người dùng$/)).toBeVisible();

  // Cancelling the confirm leaves the account untouched.
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.dismiss();
  });
  await row.getByRole("button", { name: "Ngừng hoạt động" }).click();
  await expect.poll(() => message).toContain(target.name);
  expect(message).toContain(target.email);
  expect(message).toContain("đăng xuất");
  await expect(row).toContainText("Chờ kích hoạt");

  // Accepting deactivates.
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Ngừng hoạt động" }).click();
  await expect(
    row.getByRole("button", { name: "Kích hoạt lại" }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Ngừng hoạt động" }),
  ).toHaveCount(0);

  // Reactivate: a never-activated account goes back to pending.
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Kích hoạt lại" }).click();
  await expect(row).toContainText("Chờ kích hoạt");
  await expect(
    page.getByRole("status").filter({ hasText: "Đã kích hoạt lại" }),
  ).toBeVisible();
  const after = await apiAsPage(page, "GET", `/users/${target.id}`);
  expect((after.body as UserItem).status).toBe("pending");
});

test("cấp quyền owner hỏi xác nhận — huỷ thì vai trò giữ nguyên", async ({
  page,
}) => {
  await loginAs(page, "owner");
  const target = await createPending(page, "grant");
  await page.goto("/admin.html");
  await page.getByRole("tab", { name: "Người dùng" }).click();
  await page.getByLabel("Tìm người dùng").fill(target.email);
  const row = page.locator("#panel-users tbody tr", { hasText: target.email });

  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.dismiss();
  });
  await row.getByRole("button", { name: "Cấp quyền owner" }).click();
  await expect.poll(() => message).toContain(target.name);
  expect(message).toContain("toàn quyền");
  const res = await apiAsPage(page, "GET", `/users/${target.id}`);
  expect((res.body as UserItem).roles).toEqual(["member"]);
});

test("admin kích hoạt lại được member đã ngừng hoạt động", async ({ page }) => {
  await loginAs(page, "admin");
  const target = await createPending(page, "admin-react");
  expect(
    (await apiAsPage(page, "POST", `/users/${target.id}/deactivate`, {}))
      .status,
  ).toBe(200);
  await page.goto("/admin.html");
  await page.getByRole("tab", { name: "Người dùng" }).click();
  await page.getByLabel("Tìm người dùng").fill(target.email);
  const row = page.locator("#panel-users tbody tr", { hasText: target.email });
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Kích hoạt lại" }).click();
  await expect(row).toContainText("Chờ kích hoạt");
});

test("header có Canvas Online + Coaching Report; footer không còn chữ Phase", async ({
  page,
}) => {
  await loginAs(page, "admin");
  await page.goto("/admin.html");
  const nav = page.getByRole("navigation", { name: "Công cụ" });
  await expect(
    nav.getByRole("link", { name: "Canvas Online" }),
  ).toHaveAttribute("href", "/canvas-online/");
  await expect(
    nav.getByRole("link", { name: "Coaching Report" }),
  ).toHaveAttribute("href", "/coaching-report/");
  await expect(page.locator("footer.app")).toBeVisible();
  await expect(page.locator("footer.app")).not.toContainText("Phase");
});

test("thông tin công ty + đổi tên tổ qua form thật", async ({ page }) => {
  await loginAs(page, "admin");
  const before = await apiAsPage(page, "GET", "/company");
  const company = before.body as { name: string; timezone: string };

  const stamp = Date.now();
  const dep = await apiAsPage(page, "POST", "/departments", {
    name: `Khối tổ ${stamp}`,
  });
  const team = await apiAsPage(page, "POST", "/teams", {
    name: `Tổ cũ ${stamp}`,
    departmentId: (dep.body as { id: string }).id,
  });
  expect(team.status).toBe(201);

  await page.goto("/admin.html");
  // Company profile (owner/admin per server policy).
  await expect(page.getByLabel("Tên công ty")).toHaveValue(company.name);
  await expect(page.getByLabel("Múi giờ")).toHaveValue(company.timezone);
  try {
    await page.getByLabel("Tên công ty").fill(`${company.name} E2E`);
    await page
      .getByRole("button", { name: "Lưu thông tin công ty" })
      .click();
    await expect(page.getByText("Đã lưu thông tin công ty.")).toBeVisible();
    const saved = await apiAsPage(page, "GET", "/company");
    expect((saved.body as { name: string }).name).toBe(
      `${company.name} E2E`,
    );
  } finally {
    await apiAsPage(page, "PATCH", "/company", { name: company.name });
  }

  // Team rename mirrors the department rename.
  await page
    .getByRole("button", { name: `Đổi tên tổ Tổ cũ ${stamp}` })
    .click();
  await page.getByLabel("Tên tổ mới").fill(`Tổ mới ${stamp}`);
  await page.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(
    page.getByText(`Tổ mới ${stamp}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(`Tổ cũ ${stamp}`, { exact: true })).toHaveCount(
    0,
  );
});

test("retention: owner chỉnh được, mức dưới sàn bị server từ chối; admin chỉ xem", async ({
  page,
  browser,
}) => {
  await loginAs(page, "owner");
  await page.goto("/admin.html");
  const audit = page.getByLabel("Nhật ký audit (ngày)");
  await expect(audit).toBeEnabled();
  await expect(audit).not.toHaveValue("");
  const current = await audit.inputValue();
  expect(Number(current)).toBeGreaterThanOrEqual(365);
  await expect(page.getByText("Tối thiểu 365 ngày.")).toBeVisible();

  // Below the floor: the server's 400 is surfaced, naming the field.
  await audit.fill("100");
  await page.getByRole("button", { name: "Lưu thời gian lưu giữ" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Nhật ký audit" }),
  ).toBeVisible();

  // Restoring the stored value saves cleanly (idempotent across runs).
  await audit.fill(current);
  await page.getByRole("button", { name: "Lưu thời gian lưu giữ" }).click();
  await expect(page.getByText("Đã lưu thời gian lưu giữ.")).toBeVisible();

  // Admin sees the values read-only — PATCH is owner-only server-side.
  const origin = new URL(page.url()).origin;
  const adminCtx = await browser.newContext({ baseURL: origin });
  try {
    const adminPage = await adminCtx.newPage();
    await loginAs(adminPage, "admin");
    await adminPage.goto("/admin.html");
    await expect(
      adminPage.getByLabel("Nhật ký audit (ngày)"),
    ).toBeDisabled();
    await expect(
      adminPage.getByRole("button", { name: "Lưu thời gian lưu giữ" }),
    ).toHaveCount(0);
  } finally {
    await adminCtx.close();
  }
});
