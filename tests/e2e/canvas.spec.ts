import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { apiAsPage, loginAs } from "../helpers/browser.js";

/**
 * Task 2.5 — the canvas editor on the real revision-aware API
 * (spec §5.2/§9). Everything here runs the real browser stack:
 * requireAuth → GET /canvases/:id → debounced serialized CAS autosave
 * (PUT /draft with expectedRevision + baseVersionId) → publish → the
 * immutable-version history view. No localStorage persistence, no demo
 * fallback — a reload reproduces server state, and a second tab's stale
 * save surfaces as a 409 conflict UI that never auto-overwrites.
 */

interface CanvasBodyT {
  meta: { title: string; stage: string };
  goal: { statement: string };
}

interface DraftDtoT {
  revision: number;
  body: { goal: { statement: string } };
}

interface CanvasDtoT {
  id: string;
  status: string;
  draft: DraftDtoT | null;
  currentVersion: { id: string; versionNo: number } | null;
}

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as CanvasBodyT;

const editorUrl = (canvasId: string) =>
  `/canvas-online/?canvas=${encodeURIComponent(canvasId)}`;

/** Canonical fixture body at stage DRAFT — publishable as-is. */
function draftBody(): CanvasBodyT {
  const body = JSON.parse(JSON.stringify(canonical)) as CanvasBodyT;
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

/** Navigate to the editor and wait until the real draft rendered. */
async function openEditor(page: Page, canvasId: string) {
  await page.goto(editorUrl(canvasId));
  const goal = page.getByLabel("Mục tiêu (Goal)");
  await expect(goal).toBeVisible({ timeout: 20_000 });
  return goal;
}

test.describe("Canvas editor on the revision-aware API (task 2.5)", () => {
  test("unauthenticated visitor is redirected to login — no canvas content", async ({
    page,
  }) => {
    await page.goto(editorUrl(randomUUID()));
    await expect(page).toHaveURL(/\/index\.html/);
  });

  test("no-param URL opens the creation flow — new canvas lands in the editor", async ({
    page,
  }) => {
    await loginAs(page, "member");
    await page.goto("/canvas-online/");
    const create = page.getByTestId("canvas-create");
    await expect(create).toBeVisible();
    await create.getByLabel("Tên canvas").fill("Canvas e2e — tạo mới");
    await create.getByRole("button", { name: "Tạo canvas" }).click();
    // Lands on the real editor with a canvas id — the created draft renders.
    await expect(page).toHaveURL(/\/canvas-online\/\?canvas=/);
    const goal = page.getByLabel("Mục tiêu (Goal)");
    await expect(goal).toBeVisible({ timeout: 20_000 });
    // …and the shared draft autosaves like any other canvas.
    await goal.fill("Mục tiêu từ canvas vừa tạo");
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });
  });

  test("editor loads the shared draft, autosaves and reloads it from the API", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — reload");
    const goal = await openEditor(page, canvasId);

    await goal.fill("Mục tiêu được lưu trên máy chủ");
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });

    await page.reload();
    await expect(page.getByLabel("Mục tiêu (Goal)")).toHaveValue(
      "Mục tiêu được lưu trên máy chủ",
    );
  });

  test("a second tab's stale save surfaces the 409 conflict UI — nothing is overwritten", async ({
    page,
    context,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — conflict");
    const THEIRS = "Tab A ghi trước <img src=x onerror=window.__xss=1>";
    const MINE = "Bản nháp của tab B — không được mất";

    const tabA = page;
    const tabB = await context.newPage();
    await openEditor(tabA, canvasId);
    await openEditor(tabB, canvasId);

    // Tab A saves first — the draft revision moves on.
    await tabA.getByLabel("Mục tiêu (Goal)").fill(THEIRS);
    await expect(tabA.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });

    // Tab B still holds the old revision: its save must conflict.
    await tabB.getByLabel("Mục tiêu (Goal)").fill(MINE);
    await expect(tabB.getByTestId("conflict-banner")).toBeVisible({
      timeout: 15_000,
    });
    await expect(tabB.getByTestId("save-state")).toHaveText(/Xung đột/);

    // B's local text is preserved verbatim — never auto-overwritten.
    await expect(tabB.getByLabel("Mục tiêu (Goal)")).toHaveValue(MINE);
    const remote = await apiAsPage(tabB, "GET", `/canvases/${canvasId}`);
    expect((remote.body as CanvasDtoT).draft?.body.goal.statement).toBe(
      THEIRS,
    );

    // The diff view shows both sides and renders user markup inert.
    await tabB.getByRole("button", { name: "Xem khác biệt" }).click();
    const diff = tabB.getByTestId("conflict-diff");
    await expect(diff).toContainText(MINE);
    await expect(diff).toContainText(THEIRS);
    await expect(tabB.locator("#conflictDiff img")).toHaveCount(0);
    expect(await tabB.evaluate(() => (window as unknown as Record<string, unknown>).__xss)).toBeUndefined();

    // "Tải bản mới nhất" is an explicit, confirmed choice — then editing resumes.
    tabB.once("dialog", (d) => void d.accept());
    await tabB.getByRole("button", { name: "Tải bản mới nhất" }).click();
    await expect(tabB.getByLabel("Mục tiêu (Goal)")).toHaveValue(THEIRS);
    await expect(tabB.getByTestId("conflict-banner")).toBeHidden();
    await expect(tabB.getByTestId("save-state")).toHaveText(/Đã lưu/);
  });

  test("a transient save failure lands in error state and retry saves", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — retry");
    const goal = await openEditor(page, canvasId);

    let blocked = true;
    await page.route("**/api/v1/canvases/*/draft", async (route) => {
      if (blocked && route.request().method() === "PUT") {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await goal.fill("Lưu thất bại một lần");
    await expect(page.getByTestId("save-state")).toHaveText(/Lỗi/, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("save-retry")).toBeVisible();

    blocked = false;
    await page.getByTestId("save-retry").click();
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });
    await page.unrouteAll();
  });

  test("beforeunload warns while the draft is dirty and not once saved", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — beforeunload");
    const goal = await openEditor(page, canvasId);

    // Deterministic: dispatching beforeunload returns false exactly when a
    // handler cancelled it — no dialog flakiness.
    const warned = () =>
      page.evaluate(
        () =>
          window.dispatchEvent(
            new Event("beforeunload", { cancelable: true }),
          ) === false,
      );

    await page.route("**/api/v1/canvases/*/draft", async (route) => {
      if (route.request().method() === "PUT") {
        await route.abort();
        return;
      }
      await route.continue();
    });
    await goal.fill("Chưa lưu được");
    await expect(page.getByTestId("save-state")).toHaveText(/Lỗi/, {
      timeout: 15_000,
    });
    expect(await warned()).toBe(true);

    await page.unrouteAll();
    // The beforeunload dispatched by warned() runs the editor's best-effort
    // keepalive flush, which page.route does not intercept — so the draft
    // may already be saved and "Thử lại" correctly hidden. Retry only while
    // the state is still an error (no auto-retry exists, so it stays put).
    const saveState = page.getByTestId("save-state");
    if (/Lỗi/.test((await saveState.textContent()) ?? "")) {
      await page.getByTestId("save-retry").click();
    }
    await expect(saveState).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });
    expect(await warned()).toBe(false);
  });

  test("malicious markup stays inert — in preview and after a reload", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — xss");
    const goal = await openEditor(page, canvasId);
    const payload =
      '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';

    await goal.fill(payload);
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Xem trước" }).click();
    await expect(page.locator("#preview img[onerror]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__xss)).toBeUndefined();

    await page.reload();
    await expect(page.getByLabel("Mục tiêu (Goal)")).toHaveValue(payload);
    await page.getByRole("button", { name: "Xem trước" }).click();
    await expect(page.locator("#preview img[onerror]")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__xss)).toBeUndefined();
  });

  test("a denied canvas shows a friendly permission state, not the form", async ({
    page,
    browser,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — denied");

    // outsider is inside the company but outside any subtree that can see
    // member's canvas — the API answers 404 and the page must say so.
    const other = await browser.newContext();
    try {
      const page2 = await other.newPage();
      await loginAs(page2, "outsider");
      await page2.goto(editorUrl(canvasId));
      await expect(page2.getByTestId("canvas-denied")).toContainText(
        /không có quyền/i,
        { timeout: 20_000 },
      );
      await expect(page2.locator("#editorMain")).toBeHidden();
    } finally {
      await other.close();
    }
  });

  test("publish produces immutable v1 — history lists, views, restores, exports", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — publish");
    const goal = await openEditor(page, canvasId);

    // Accept every confirm() this test triggers (publish, restore).
    page.on("dialog", (d) => void d.accept());

    await page.getByRole("button", { name: "Chốt phiên bản" }).click();
    await expect(page.getByTestId("version-number")).toHaveText("v1", {
      timeout: 20_000,
    });

    // History lists the immutable version and opens it read-only.
    await page.getByRole("button", { name: "Lịch sử" }).click();
    const history = page.getByTestId("history-panel");
    await expect(history).toBeVisible();
    const row = page.getByTestId("version-row");
    await expect(row).toHaveCount(1);
    await expect(row.first()).toContainText("v1");
    await expect(row.first()).toContainText("Fixture Member");
    await row.getByRole("button", { name: "Xem", exact: true }).click();
    const view = page.getByTestId("version-view");
    await expect(view).toContainText("Canvas e2e — publish");
    await expect(view).toContainText(canonical.goal.statement);

    // A per-version export downloads without a round-trip through state.
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "JSON" }).click();
    expect((await download).suggestedFilename()).toMatch(/\.json$/);

    // Edit the live draft, then restore v1 — CAS-confirmed, confirmed by dialog.
    await goal.fill("Thay đổi sau khi chốt v1");
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });
    await row.getByRole("button", { name: "Khôi phục" }).click();
    await expect(page.getByLabel("Mục tiêu (Goal)")).toHaveValue(
      canonical.goal.statement,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/);
  });
});
