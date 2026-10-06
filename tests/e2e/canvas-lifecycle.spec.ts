import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { apiAsPage, loginAs } from "../helpers/browser.js";

/**
 * Canvas lifecycle from the editor's "Quản lý canvas" card:
 *
 * - rename (PATCH /canvases/:id) — any actor with edit access;
 * - transfer owner — owner role only; other roles see why it is locked;
 *   a confirm dialog explains the permission impact first;
 * - archive — confirm dialog lists the consequences; afterwards (and
 *   after a reload) the editor is read-only and says so;
 * - "＋ Tạo canvas mới" in the editor toolbar opens the creation flow.
 *
 * Real login + real API only. The e2e DB persists between runs, so
 * names carry a per-run suffix.
 */

const RUN = randomUUID().slice(0, 8);

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as { meta: { stage: string } };

function draftBody() {
  const body = JSON.parse(JSON.stringify(canonical)) as { meta: { stage: string } };
  body.meta.stage = "DRAFT";
  return body;
}

async function myUserId(page: Page): Promise<string> {
  const me = await apiAsPage(page, "GET", "/auth/me");
  return (me.body as { user: { id: string } }).user.id;
}

async function createCanvas(page: Page, name: string): Promise<string> {
  const res = await apiAsPage(page, "POST", "/canvases", {
    ownerUserId: await myUserId(page),
    name,
    body: draftBody(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

async function openEditor(page: Page, canvasId: string): Promise<void> {
  await page.goto(`/canvas-online/?canvas=${encodeURIComponent(canvasId)}`);
  await expect(page.getByLabel("Mục tiêu (Goal)")).toBeVisible({
    timeout: 20_000,
  });
}

async function openManage(page: Page) {
  await page.getByTestId("manage-toggle").click();
  const panel = page.getByTestId("manage-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("canvas lifecycle — Quản lý canvas", () => {
  test("member renames own canvas; transfer is explained as owner-only", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const id = await createCanvas(page, `Lifecycle ${RUN} — gốc`);
    await openEditor(page, id);
    const panel = await openManage(page);

    await expect(panel.getByTestId("manage-name")).toHaveText(
      `Lifecycle ${RUN} — gốc`,
    );
    await panel.getByLabel("Đổi tên canvas").fill(`Lifecycle ${RUN} — mới`);
    await panel.getByRole("button", { name: "Lưu tên" }).click();
    await expect(panel.getByTestId("manage-status-line")).toContainText(
      "Đã đổi tên",
    );
    await expect(panel.getByTestId("manage-name")).toHaveText(
      `Lifecycle ${RUN} — mới`,
    );
    const detail = await apiAsPage(page, "GET", `/canvases/${id}`);
    expect((detail.body as { name: string }).name).toBe(
      `Lifecycle ${RUN} — mới`,
    );

    // Transfer is owner-role only — locked with an explanation.
    await expect(
      panel.getByRole("button", { name: "Chuyển chủ sở hữu" }),
    ).toBeDisabled();
    await expect(panel).toContainText("Chỉ tài khoản có vai trò owner");
  });

  test("owner transfers a canvas after confirming the permission impact", async ({
    page,
  }) => {
    await loginAs(page, "owner");
    const id = await createCanvas(page, `Transfer ${RUN}`);
    await openEditor(page, id);
    const panel = await openManage(page);

    await panel
      .getByLabel("Chuyển chủ sở hữu")
      .selectOption({ label: "Fixture Member — member@example.test" });

    // Cancel first — nothing changes.
    await panel.getByRole("button", { name: "Chuyển chủ sở hữu" }).click();
    const dialog = page.getByTestId("transfer-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Quyền xem/sửa đi theo chủ mới");
    await dialog.getByRole("button", { name: "Hủy" }).click();
    await expect(dialog).toHaveCount(0);
    let detail = await apiAsPage(page, "GET", `/canvases/${id}`);
    expect((detail.body as { ownerUserId: string }).ownerUserId).toBe(
      await myUserId(page),
    );

    // Confirm — ownership moves; the owner role keeps company-wide access.
    await panel.getByRole("button", { name: "Chuyển chủ sở hữu" }).click();
    await page
      .getByTestId("transfer-dialog")
      .getByRole("button", { name: "Chuyển chủ sở hữu" })
      .click();
    await expect(panel.getByTestId("manage-status-line")).toContainText(
      "Đã chuyển chủ sở hữu",
    );
    await expect(panel.getByTestId("manage-owner")).toHaveText(
      "Fixture Member",
    );
    detail = await apiAsPage(page, "GET", `/canvases/${id}`);
    expect((detail.body as { ownerName: string }).ownerName).toBe(
      "Fixture Member",
    );
  });

  test("archive asks for confirmation, then the editor is read-only (also after reload)", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const id = await createCanvas(page, `Archive ${RUN}`);
    await openEditor(page, id);
    const panel = await openManage(page);

    await panel.getByRole("button", { name: "Lưu trữ canvas" }).click();
    const dialog = page.getByTestId("archive-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("CHỈ XEM");
    await expect(dialog).toContainText("Bỏ lưu trữ");
    await dialog.getByRole("button", { name: "Lưu trữ canvas" }).click();

    await expect(page.getByTestId("archived-banner")).toBeVisible();
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu trữ/);
    await expect(page.getByLabel("Mục tiêu (Goal)")).toBeDisabled();
    await expect(page.getByRole("button", { name: /Chốt phiên bản/ })).toBeHidden();
    await expect(page.getByTestId("ai-panel")).toBeHidden();
    const detail = await apiAsPage(page, "GET", `/canvases/${id}`);
    expect((detail.body as { status: string }).status).toBe("archived");

    await page.reload();
    await expect(page.getByTestId("archived-banner")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel("Mục tiêu (Goal)")).toBeDisabled();
  });

  test("unarchive from the banner reopens the editor writable", async ({ page }) => {
    await loginAs(page, "member");
    const id = await createCanvas(page, `Unarchive ${RUN}`);
    const archived = await apiAsPage(page, "POST", `/canvases/${id}/archive`, {});
    expect(archived.status).toBe(200);
    await openEditor(page, id);
    await expect(page.getByTestId("archived-banner")).toBeVisible({
      timeout: 20_000,
    });

    // Cancel keeps it archived; confirm unarchives and reloads writable.
    await page.getByTestId("unarchive").click();
    const dialog = page.getByTestId("unarchive-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Hủy" }).click();
    await expect(page.getByTestId("archived-banner")).toBeVisible();

    await page.getByTestId("unarchive").click();
    await dialog.getByRole("button", { name: "Bỏ lưu trữ" }).click();
    await expect(page.getByTestId("archived-banner")).toBeHidden({
      timeout: 20_000,
    });
    const goal = page.getByLabel("Mục tiêu (Goal)");
    await expect(goal).toBeEnabled();
    await expect(page.getByRole("button", { name: /Chốt phiên bản/ })).toBeVisible();
    await goal.fill(`Sửa lại sau khi bỏ lưu trữ ${RUN}`);
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });
    const detail = await apiAsPage(page, "GET", `/canvases/${id}`);
    expect((detail.body as { status: string }).status).toBe("active");
  });

  test("toolbar '＋ Tạo canvas mới' opens the creation flow", async ({ page }) => {
    await loginAs(page, "member");
    const id = await createCanvas(page, `New link ${RUN}`);
    await openEditor(page, id);
    await page.getByTestId("new-canvas").click();
    await expect(page).toHaveURL(/\/canvas-online\/$/);
    await expect(page.getByTestId("canvas-create")).toBeVisible();
  });
});
