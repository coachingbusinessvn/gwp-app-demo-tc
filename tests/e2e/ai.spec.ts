import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { apiAsPage, loginAs } from "../helpers/browser.js";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm.js";

/**
 * Task 3.6 — the local-AI experience on the real canvas editor.
 *
 * The suite drives the REAL browser path: consent-gated run → fetch-SSE
 * stream → server-validated preview → explicit apply. The upstream is a
 * fake loopback LLM on a fixed port that the e2e server's
 * AI_ALLOWED_HOSTS pins (playwright.config.ts) — the same production
 * allowlist code path, never a mock.
 *
 * Contracts under test:
 * - consent checkbox gates "Chạy AI" and RESETS after every run;
 * - AI off / missing key is explained before consent (consent + run
 *   locked), editing unaffected;
 * - the streamed preview is diffed, warnings need explicit acceptance,
 *   apply lands in the draft only — publish stays a separate human step;
 * - cancel mid-run stops the run; invalid output renders as a plain-text
 *   diagnostic, never trusted markup.
 */

const LLM_PORT = 18923;
const LLM_URL = `http://127.0.0.1:${LLM_PORT}`;
const APP_ORIGIN = "http://localhost:8901"; // playwright.config.ts baseURL

const canonicalMd = readFileSync(
  new URL("../fixtures/canvas/canonical.md", import.meta.url),
  "utf8",
);
const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as { meta: { stage: string } };

function draftBody() {
  const body = JSON.parse(JSON.stringify(canonical)) as {
    meta: { stage: string };
  };
  body.meta.stage = "DRAFT";
  return body;
}

/** A proposal: canonical canvas with a changed goal statement, same
 *  DRAFT stage as the draft under test — so apply needs no warnings. */
const PROPOSED_MD = canonicalMd
  .replace(
    "Giảm nợ chuyển nhóm bằng cách nâng chất lượng liên hệ sớm",
    "Giảm nợ nhóm 2 bằng liên hệ sớm có kiểm chứng",
  )
  .replace("**Canvas Stage:** PILOTING", "**Canvas Stage:** DRAFT");
const ANSWER = `## Phân tích dữ liệu phiên\n\n**Insight:** dữ liệu nói đủ.\n\n${PROPOSED_MD}`;

function sseResponse(chunks: string[]) {
  return {
    kind: "sse" as const,
    frames: [
      ...chunks.map(
        (c) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`,
      ),
      "data: [DONE]\n\n",
    ],
  };
}

async function createCanvas(page: Page): Promise<string> {
  const me = await apiAsPage(page, "GET", "/auth/me");
  const res = await apiAsPage(page, "POST", "/canvases", {
    ownerUserId: (me.body as { user: { id: string } }).user.id,
    name: "Canvas AI e2e",
    body: draftBody(),
  });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function configureAi(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  // Owner-only operation — from a SEPARATE context: sharing the member's
  // context would already hold a session and index.html would redirect
  // before the login form renders.
  // Never derive origin from page.url() — the page may still be on
  // about:blank before its first navigation.
  const ctx = await page.context().browser()!.newContext({
    baseURL: APP_ORIGIN,
  });
  try {
    const owner = await ctx.newPage();
    await loginAs(owner, "owner");
    const res = await apiAsPage(owner, "PUT", "/settings/ai", {
      enabled: true,
      baseUrl: LLM_URL,
      apiKey: "e2e-local-secret",
      model: "pilot",
      ...overrides,
    });
    expect(res.status).toBe(200);
  } finally {
    await ctx.close();
  }
}

test.describe("local AI on the canvas editor (task 3.6)", () => {
  test("consent gates the run; stream → preview → explicit apply → draft only", async ({
    page,
  }) => {
    const llm = await fakeLlm({
      port: LLM_PORT,
      respondWith: sseResponse([ANSWER.slice(0, 200), ANSWER.slice(200)]),
    });
    try {
      await loginAs(page, "member");
      const canvasId = await createCanvas(page);
      await configureAi(page);
      await page.goto(`/canvas-online/?canvas=${canvasId}`);

      const run = page.getByRole("button", { name: "Chạy AI", exact: true });
      await expect(run).toBeDisabled(); // consent unchecked
      await page
        .getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ")
        .check();
      await expect(run).toBeEnabled();
      await run.click();

      const preview = page.getByTestId("ai-preview");
      await expect(preview).toBeVisible({ timeout: 20_000 });
      await expect(preview).toContainText("liên hệ sớm có kiểm chứng");

      // Consent must re-arm for the next run — never sticky.
      await expect(
        page.getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ"),
      ).not.toBeChecked();

      const applyBtn = page.getByRole("button", {
        name: "Áp dụng vào bản nháp",
      });
      await applyBtn.click();
      await expect(page.getByTestId("ai-status")).toContainText("Đã áp dụng");

      // The applied goal is now IN the editable form — draft changed…
      await expect(page.locator("#f_goal")).toHaveValue(
        /liên hệ sớm có kiểm chứng/,
      );
      // …but nothing was published: the chip still says draft.
      await expect(page.getByTestId("version-number")).toHaveText("Nháp");
      const det = await apiAsPage(page, "GET", `/canvases/${canvasId}`);
      expect(
        (det.body as { currentVersion: unknown }).currentVersion,
      ).toBeNull();
      expect(llm.requests.length).toBeGreaterThan(0);
    } finally {
      await llm.close();
    }
  });

  test("AI not configured → explained BEFORE consent, run locked, editing still works", async ({
    page,
  }) => {
    // The e2e DB is shared across the file — prior tests already saved
    // settings, so "not configured" is produced by clearing the key.
    const ctx = await page.context().browser()!.newContext({
      baseURL: APP_ORIGIN,
    });
    try {
      const owner = await ctx.newPage();
      await loginAs(owner, "owner");
      await apiAsPage(owner, "DELETE", "/settings/ai/key");
    } finally {
      await ctx.close();
    }

    await loginAs(page, "member");
    const canvasId = await createCanvas(page);
    await page.goto(`/canvas-online/?canvas=${canvasId}`);

    // Spec §7.1: the panel says so up front (GET /ai/status) — the user
    // never gets to consent to a run that cannot happen.
    const notice = page.getByTestId("ai-unavailable");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText("chưa được cấu hình");
    await expect(notice).not.toContainText("AI_NOT_CONFIGURED");
    await expect(
      page.getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ"),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Chạy AI", exact: true }),
    ).toBeDisabled();

    // The editor itself is unaffected — a manual edit still autosaves.
    await page.locator("#f_goal").fill("Mục tiêu tự sửa khi AI tắt");
    await expect(page.getByTestId("save-state")).toHaveText(/Đã lưu/, {
      timeout: 15_000,
    });
  });

  test("invalid model output → plain-text diagnostic, no apply", async ({
    page,
  }) => {
    const llm = await fakeLlm({
      port: LLM_PORT,
      respondWith: sseResponse(["Đây là phân tích không có canvas nào."]),
    });
    try {
      await loginAs(page, "member");
      const canvasId = await createCanvas(page);
      await configureAi(page);
      await page.goto(`/canvas-online/?canvas=${canvasId}`);
      await page
        .getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ")
        .check();
      await page
        .getByRole("button", { name: "Chạy AI", exact: true })
        .click();

      const preview = page.getByTestId("ai-preview");
      await expect(preview).toBeVisible({ timeout: 20_000 });
      await expect(preview).toContainText("RENDER_NO_CANVAS");
      await expect(
        page.getByRole("button", { name: "Áp dụng vào bản nháp" }),
      ).toHaveCount(0);
    } finally {
      await llm.close();
    }
  });

  test("cancel mid-run stops the run — no preview is staged", async ({
    page,
  }) => {
    // The upstream holds the response open until the client aborts, so
    // the run is definitely in-flight when we cancel.
    const llm = await fakeLlm({
      port: LLM_PORT,
      respondWith: { kind: "hang" },
    });
    try {
      await loginAs(page, "member");
      const canvasId = await createCanvas(page);
      // A short upstream timeout keeps the test bounded if abort ever
      // failed to propagate — cancel should win first.
      await configureAi(page, { timeoutSeconds: 20 });
      await page.goto(`/canvas-online/?canvas=${canvasId}`);
      await page
        .getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ")
        .check();
      await page
        .getByRole("button", { name: "Chạy AI", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Hủy chạy AI" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Hủy chạy AI" }).click();
      await expect(page.getByTestId("ai-status")).toContainText(
        /cancelled|đã hủy/i,
      );
      await expect(page.getByTestId("ai-preview")).toHaveCount(0);
    } finally {
      await llm.close();
    }
  });
});
