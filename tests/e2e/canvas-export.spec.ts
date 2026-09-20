import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { apiAsPage, loginAs } from "../helpers/browser.js";

/**
 * Task 2.7 — the audited export boundary, browser-side.
 *
 * Toolbar exports (JSON/Markdown/XLSX/PDF) go through
 * POST /canvases/:id/export-preview — autosave flushes first, the server
 * authorizes + audits, and the client renders the returned draft (not
 * whatever the tab holds). Published-version exports go through
 * GET .../versions/:id/export?format= which returns content + loss
 * warnings. Denied callers get the same 404 as a missing canvas.
 */

interface CanvasBodyT {
  meta: { title: string; stage: string };
  goal: { statement: string };
  observed: Record<string, unknown>[];
}

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as CanvasBodyT;

const editorUrl = (canvasId: string) =>
  `/canvas-online/?canvas=${encodeURIComponent(canvasId)}`;

function draftBody(over: Partial<CanvasBodyT> = {}): CanvasBodyT {
  const body = JSON.parse(JSON.stringify(canonical)) as CanvasBodyT;
  body.meta.stage = "DRAFT";
  return Object.assign(body, over);
}

async function myUserId(page: Page): Promise<string> {
  const me = await apiAsPage(page, "GET", "/auth/me");
  return (me.body as { user: { id: string } }).user.id;
}

async function createCanvas(
  page: Page,
  name: string,
  body = draftBody(),
): Promise<string> {
  const res = await apiAsPage(page, "POST", "/canvases", {
    ownerUserId: await myUserId(page),
    name,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

async function openEditor(page: Page, canvasId: string) {
  await page.goto(editorUrl(canvasId));
  const goal = page.getByLabel("Mục tiêu (Goal)");
  await expect(goal).toBeVisible({ timeout: 20_000 });
  return goal;
}

test.describe("Audited canvas exports (task 2.7)", () => {
  test("toolbar JSON export carries the server-saved draft — edits flush first", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — export");
    const goal = await openEditor(page, canvasId);

    // Edit and export immediately — exportableDraft() flushes the
    // debounced autosave before POST /export-preview, so the artifact
    // contains the just-typed text, not a stale draft.
    await goal.fill("Mục tiêu vừa sửa tức thì");
    const download = page.waitForEvent("download");
    await page.locator("#btnJson").click();
    const file = await (await download).path();
    const exported = JSON.parse(readFileSync(file, "utf8")) as CanvasBodyT;
    expect(exported.goal.statement).toBe("Mục tiêu vừa sửa tức thì");
  });

  test("a failed save aborts the export — no audited artifact of stale state", async ({
    page,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — lỗi lưu");
    const goal = await openEditor(page, canvasId);

    // Kill the draft-save channel: the flush inside exportableDraft()
    // must land in "error", and the export must abort rather than ship a
    // stale server draft as if it were current.
    await page.route(`**/canvases/${canvasId}/draft`, (route) =>
      route.abort(),
    );
    await goal.fill("Nội dung chưa lưu được");
    let previewCalled = false;
    page.on("request", (req) => {
      if (req.url().includes("export-preview")) previewCalled = true;
    });
    // Accept the alert — a lingering native dialog blocks page.evaluate.
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await page.locator("#btnJson").click();
    await expect.poll(() => dialogs.join("|")).toContain("chưa lưu được");
    expect(previewCalled).toBe(false);
    await expect(page.getByTestId("save-state")).toHaveText(/Lỗi/);
  });

  test("published version exports: JSON byte-faithful, Markdown flagged when extensions drop", async ({
    page,
  }) => {
    await loginAs(page, "member");
    // A body with an extension Markdown cannot carry (measurement).
    const body = draftBody();
    body.observed = [
      {
        id: randomUUID(),
        date: "2026-09-10",
        layer: "OUTPUT",
        value: "78%",
        source: "báo cáo",
        confidence: "HIGH",
        learning: "",
        decision: "",
        verifier: "",
        measurement: {
          metricId: randomUUID(),
          definitionRevision: 1,
          layer: "OUTPUT",
          date: "2026-09-10",
          value: 78,
          unit: "%",
          baseline: 65,
          target: 75,
        },
      },
    ];
    const canvasId = await createCanvas(page, "Canvas e2e — xuất bản", body);
    await openEditor(page, canvasId);

    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });

    await page.getByRole("button", { name: "Chốt phiên bản" }).click();
    await expect(page.getByTestId("version-number")).toHaveText("v1", {
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "Lịch sử" }).click();
    const row = page.getByTestId("version-row");
    await expect(row).toHaveCount(1);

    // JSON: the immutable body round-trips.
    const dlJson = page.waitForEvent("download");
    await row.getByRole("button", { name: "JSON" }).click();
    const jsonFile = await (await dlJson).path();
    const json = JSON.parse(readFileSync(jsonFile, "utf8")) as CanvasBodyT;
    expect(json.meta.title).toBe("Canvas e2e — xuất bản");
    expect(json.observed[0].measurement).toBeTruthy();

    // Markdown: downloads AND the loss warning is surfaced (dialog or note).
    const dlMd = page.waitForEvent("download");
    await row.getByRole("button", { name: "Markdown" }).click();
    const mdFile = await (await dlMd).path();
    const md = readFileSync(mdFile, "utf8");
    expect(md).toContain("## 1.");
    expect(md).toContain("Canvas e2e — xuất bản");
    expect(dialogs.some((m) => /mở rộng|JSON/i.test(m))).toBe(true);
  });

  test("export endpoints enforce the subject policy from the browser session", async ({
    page,
    browser,
  }) => {
    await loginAs(page, "member");
    const canvasId = await createCanvas(page, "Canvas e2e — denied export");
    // Publish via API (faster than clicking through).
    const pub = await apiAsPage(page, "POST", `/canvases/${canvasId}/publish`, {
      expectedRevision: 1,
      idempotencyKey: `pub-${randomUUID()}`,
    });
    expect(pub.status).toBe(200);
    const versions = await apiAsPage(
      page,
      "GET",
      `/canvases/${canvasId}/versions`,
    );
    const vid = (versions.body as { id: string }[])[0].id;

    // Outsider: uniform 404 on both export paths — content never leaves.
    const other = await browser.newPage();
    try {
      await loginAs(other, "outsider");
      const ex = await apiAsPage(
        other,
        "GET",
        `/canvases/${canvasId}/versions/${vid}/export?format=json`,
      );
      expect(ex.status).toBe(404);
      const pv = await apiAsPage(
        other,
        "POST",
        `/canvases/${canvasId}/export-preview`,
        {},
      );
      expect(pv.status).toBe(404);
    } finally {
      await other.close();
    }
  });
});
