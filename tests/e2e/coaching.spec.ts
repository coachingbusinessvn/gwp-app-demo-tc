import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { apiAsPage, loginAs } from "../helpers/browser.js";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm.js";

/**
 * Task 4.4 — the consented coaching-report workflow on the real page.
 *
 * The suite drives the REAL browser path end to end: pick coachee →
 * create session → paste transcript → consent-gated ORACLE run →
 * validated preview → explicit save → report list/detail → share,
 * revoke, confirmed delete → report→Renderer bridge. The upstream is the
 * same fake loopback LLM pinned by AI_ALLOWED_HOSTS — never a mock.
 *
 * Contracts under test (spec §6/§7.3):
 * - no localStorage persistence: the legacy demo key and any transcript
 *   copy must NEVER appear in browser storage;
 * - consent arms ONE run and resets when the run ends;
 * - the transcript field is cleared when the run finishes or is
 *   cancelled — content lives only in the request/run lifetime;
 * - saving is explicit ("Lưu báo cáo") and the saved report renders from
 *   a fresh authorized fetch, not preloaded state;
 * - sharing grants exactly one version, revoke denies the next request,
 *   delete needs the confirm flag;
 * - the renderer bridge carries only whitelisted recommendation fields —
 *   scores, evidence labels and quoted spans never reach the model.
 */

const LLM_PORT = 18923;
const LLM_URL = `http://127.0.0.1:${LLM_PORT}`;
const APP_ORIGIN = "http://localhost:8901"; // playwright.config.ts baseURL

const oracleCases = JSON.parse(
  readFileSync(
    new URL("../fixtures/ai/oracle-cases.json", import.meta.url),
    "utf8",
  ),
) as { transcript: string; validReport: string };

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

function llmMarkdown(content: string) {
  return {
    kind: "json" as const,
    body: {
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  };
}

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

async function configureAi(page: Page): Promise<void> {
  // Owner-only settings write — from a SEPARATE context (same pattern as
  // ai.spec.ts): sharing the member's context would redirect before the
  // login form renders.
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
    });
    expect(res.status).toBe(200);
  } finally {
    await ctx.close();
  }
}

/** Resolve a persona's user id through the company directory. */
async function userIdByEmail(page: Page, email: string): Promise<string> {
  const res = await apiAsPage(page, "GET", "/users?limit=100");
  expect(res.status).toBe(200);
  const items = (res.body as { items: { id: string; email: string }[] })
    .items;
  const hit = items.find((u) => u.email === email);
  expect(hit, `directory contains ${email}`).toBeTruthy();
  return hit!.id;
}

test.describe("coaching report workflow (task 4.4)", () => {
  test("consented grading flow: session → transcript → preview → save → share → revoke → delete", async ({
    page,
  }) => {
    const llm = await fakeLlm({
      port: LLM_PORT,
      respondWith: llmMarkdown(oracleCases.validReport),
    });
    try {
      await loginAs(page, "manager");
      await configureAi(page);
      await page.goto("/coaching-report/");

      // Session form: the coach is the logged-in manager; pick the
      // coachee from the directory dropdown and create the session.
      await expect(page.getByTestId("session-card")).toBeVisible();
      await page
        .getByLabel("Người được coach")
        .selectOption({ label: "Fixture Member — member@example.test" });
      await page.getByRole("button", { name: "Tạo phiên mới" }).click();
      await expect(page.getByTestId("session-status")).toContainText(
        "Phiên đã tạo",
      );

      // Transcript stays in memory only — consent gates the run.
      await page.getByLabel("Transcript").fill(oracleCases.transcript);
      const gradeBtn = page.getByRole("button", { name: "Chấm phiên" });
      await expect(gradeBtn).toBeDisabled();
      await page
        .getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ")
        .check();
      await expect(gradeBtn).toBeEnabled();
      await gradeBtn.click();

      // Run finishes → validated preview + explicit save button.
      await expect(
        page.getByRole("button", { name: "Lưu báo cáo" }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("grader-preview")).toContainText(
        "63/100",
      );

      // No transcript/report bytes in browser storage — the demo's
      // STORE_KEY is gone and nothing new took its place.
      expect(
        await page.evaluate(() =>
          localStorage.getItem("gwp-coaching-report-v1"),
        ),
      ).toBeNull();
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      // The transcript is cleared once the run completes.
      await expect(page.getByLabel("Transcript")).toHaveValue("");
      // Consent re-arms: it never stays checked for the next run.
      await expect(
        page.getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ"),
      ).not.toBeChecked();

      // Explicit save → the saved report renders from a fresh fetch.
      await page.getByRole("button", { name: "Lưu báo cáo" }).click();
      await expect(page.getByTestId("report-detail")).toContainText(
        "63/100",
        { timeout: 15_000 },
      );
      const list = page.getByTestId("report-list");
      await expect(list).toContainText("v1");

      // Share to the coachee — a member who is NOT on the report ACL.
      const reportId = await page
        .getByTestId("report-detail")
        .getAttribute("data-report-id");
      expect(reportId).toBeTruthy();
      const memberCtx = await page.context().browser()!.newContext({
        baseURL: APP_ORIGIN,
      });
      try {
        const memberPage = await memberCtx.newPage();
        await loginAs(memberPage, "member");

        // Before the share the coachee gets the uniform 404.
        const denied = await apiAsPage(
          memberPage,
          "GET",
          `/reports/${reportId}`,
        );
        expect(denied.status).toBe(404);

        await page.getByLabel("Chia sẻ với người dùng").selectOption({
          label: "Fixture Member — member@example.test",
        });
        await page
          .getByRole("button", { name: "Chia sẻ", exact: true })
          .click();
        // click() resolves at dispatch — wait for the PUT to land before
        // the cross-user read asserts the grant.
        await expect(page.getByTestId("share-status")).toContainText(
          "Đã chia sẻ",
        );
        const shared = await apiAsPage(
          memberPage,
          "GET",
          `/reports/${reportId}`,
        );
        expect(shared.status).toBe(200);

        // Revoke denies from the next request.
        await page
          .getByRole("button", { name: "Thu hồi chia sẻ", exact: true })
          .click();
        await expect(page.getByTestId("share-status")).toContainText(
          "Đã thu hồi",
        );
        const revoked = await apiAsPage(
          memberPage,
          "GET",
          `/reports/${reportId}`,
        );
        expect(revoked.status).toBe(404);
      } finally {
        await memberCtx.close();
      }

      // Confirmed delete — the dialog must be accepted explicitly.
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "Xóa báo cáo" }).click();
      await expect(page.getByTestId("report-detail")).toHaveCount(0);
      // The shared e2e DB keeps other runs' reports — assert THIS report's
      // row vanished rather than the version label.
      await expect(
        page.locator(`#reportList [data-report-row="${reportId}"]`),
      ).toHaveCount(0);
    } finally {
      await llm.close();
    }
  });

  test("report → Renderer bridge: field pick crosses, scores and quotes never do", async ({
    page,
  }) => {
    const proposal = canonicalMd.replace(
      "**Canvas Stage:** PILOTING",
      "**Canvas Stage:** DRAFT",
    );
    const llm = await fakeLlm({
      port: LLM_PORT,
      respondWith: llmMarkdown(oracleCases.validReport),
    });
    try {
      await loginAs(page, "manager");
      await configureAi(page);
      const memberId = await userIdByEmail(page, "member@example.test");
      const me = await apiAsPage(page, "GET", "/auth/me");
      const managerId = (me.body as { user: { id: string } }).user.id;

      // Drive the API for the setup: session → oracle run → save → a
      // writable canvas owned by the manager.
      const session = await apiAsPage(page, "POST", "/coaching-sessions", {
        coachUserId: managerId,
        coacheeUserId: memberId,
        occurredAt: "2026-09-20T10:00:00.000Z",
      });
      expect(session.status).toBe(201);
      const sessionId = (session.body as { id: string }).id;

      const runStart = await apiAsPage(page, "POST", "/ai/runs", {
        assistant: "oracle",
        sessionId,
        transcript: oracleCases.transcript,
        consent: true,
        // Unique per run — a reused e2e server keeps its DB between runs,
        // and a consumed key with a different input hash replays as 409.
        idempotencyKey: `e2e-oracle-run-${crypto.randomUUID()}`,
      });
      expect(runStart.status).toBe(201);
      const runId = (runStart.body as { runId: string }).runId;
      for (let i = 0; i < 60; i++) {
        const g = await apiAsPage(page, "GET", `/ai/runs/${runId}`);
        if ((g.body as { status: string }).status === "succeeded") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const saved = await apiAsPage(page, "POST", "/reports", {
        sessionId,
        runId,
        idempotencyKey: `e2e-save-report-${crypto.randomUUID()}`,
      });
      expect(saved.status).toBe(201);
      const reportId = (saved.body as { reportId: string }).reportId;

      const body = JSON.parse(JSON.stringify(canonical)) as {
        meta: { stage: string };
      };
      body.meta.stage = "DRAFT";
      const canvasRes = await apiAsPage(page, "POST", "/canvases", {
        ownerUserId: managerId,
        name: "Canvas bridge e2e",
        body,
      });
      expect(canvasRes.status).toBe(201);
      const canvasId = (canvasRes.body as { id: string }).id;

      // The detail view offers the bridge action on the report's canvas.
      await page.goto(`/coaching-report/?report=${reportId}`);
      await expect(page.getByTestId("report-detail")).toBeVisible();
      await page
        .getByRole("button", { name: "Dùng trong Renderer" })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/canvas-online/\\?canvas=${canvasId}&report=${reportId}`),
      );

      // The panel shows the whitelisted-field picker; only those fields
      // may enter the renderer prompt.
      await expect(page.getByTestId("report-bridge")).toBeVisible();
      await page
        .getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ")
        .check();
      // The renderer streams — enqueue the canvas proposal for the call
      // that follows the oracle grading (which used the default).
      llm.enqueue(sseResponse([proposal]));
      await page
        .getByRole("button", { name: "Chạy AI", exact: true })
        .click();
      await expect(page.getByTestId("ai-preview")).toBeVisible({
        timeout: 20_000,
      });

      const rendererReq = llm.requests.at(-1);
      const sent = JSON.stringify(rendererReq?.body);
      expect(sent).toContain("Ưu tiên cải thiện");
      expect(sent).not.toContain("Bằng chứng trực tiếp");
      expect(sent).not.toContain("63/100");
      expect(sent).not.toContain("raw-transcript-marker");
    } finally {
      await llm.close();
    }
  });
});
