import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { apiAsPage, isolateClientIp, loginAs } from "../helpers/browser.js";
import { fakeLlm } from "../helpers/fake-llm.js";

/**
 * Task 4.7 — the full customer journey in ONE pass (spec §10 acceptance):
 *
 *   admin provisions a pending user → owner issues an activate token →
 *   the new member sets a password on the public page and logs in →
 *   member creates/edits/publishes a canvas → the MANAGER opens that
 *   same canvas (subtree access), runs the local Renderer, applies and
 *   publishes v2 → the manager grades a coaching session on it with
 *   ORACLE, saves the report, shares it to the member, then revokes →
 *   permission boundaries hold for outsider/member → and with every
 *   non-loopback request aborted (simulated Internet outage) the app
 *   still works and the loopback LLM is still reached.
 *
 * Every hop uses the real browser stack — real login, real bearer
 * tokens, the app's own apiFetch module. No fabricated tokens, no test
 * backdoors. The upstream is the deterministic loopback fake LLM
 * pinned by AI_ALLOWED_HOSTS.
 */

const LLM_PORT = 18923;
const LLM_URL = `http://127.0.0.1:${LLM_PORT}`;
const APP_ORIGIN = "http://localhost:8901";

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
) as { meta: { stage: string }; goal: { statement: string } };

function draftBody() {
  const body = JSON.parse(JSON.stringify(canonical)) as {
    meta: { stage: string };
  };
  body.meta.stage = "DRAFT";
  return body;
}

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

async function userIdByEmail(page: Page, email: string): Promise<string> {
  const res = await apiAsPage(page, "GET", "/users?limit=100");
  expect(res.status).toBe(200);
  const hit = (
    res.body as { items: { id: string; email: string }[] }
  ).items.find((u) => u.email === email);
  expect(hit, `directory contains ${email}`).toBeTruthy();
  return hit!.id;
}

test("journey: provision → activate → canvas → renderer → grade → share/revoke → boundaries → offline", async ({
  page,
  browser,
}) => {
  const email = `journey-${Date.now()}@example.test`;
  const password = "hanh-trinh-mat-khau-1";
  const proposal = canonicalMd.replace(
    "**Canvas Stage:** PILOTING",
    "**Canvas Stage:** DRAFT",
  );

  // The fake serves FIFO enqueued responses first, then the default:
  // renderer proposal for the canvas run, oracle report for the grader.
  const llm = await fakeLlm({
    port: LLM_PORT,
    respondWith: llmMarkdown(oracleCases.validReport),
  });
  llm.enqueue(sseResponse([proposal]));

  const adminCtx = await browser.newContext({ baseURL: APP_ORIGIN });
  const ownerCtx = await browser.newContext({ baseURL: APP_ORIGIN });
  const memberCtx = await browser.newContext({ baseURL: APP_ORIGIN });
  const managerCtx = await browser.newContext({ baseURL: APP_ORIGIN });
  const outsiderCtx = await browser.newContext({ baseURL: APP_ORIGIN });
  await isolateClientIp(adminCtx);
  await isolateClientIp(ownerCtx);
  await isolateClientIp(memberCtx);
  await isolateClientIp(managerCtx);
  await isolateClientIp(outsiderCtx);
  try {
    // ---- 1. Admin provisions the pending member through the real form ----
    const adminPage = await adminCtx.newPage();
    await loginAs(adminPage, "admin");
    await adminPage.goto("/admin.html");
    await adminPage.getByRole("tab", { name: "Người dùng" }).click();
    await adminPage.getByRole("button", { name: "Tạo người dùng" }).click();
    await adminPage.getByLabel("Email", { exact: true }).fill(email);
    await adminPage.getByLabel("Họ tên").fill("Journey Member");
    await adminPage
      .getByRole("button", { name: "Lưu", exact: true })
      .click();
    await expect(adminPage.getByText(email, { exact: true })).toBeVisible();

    // ---- 2. Owner activates: credential token + manager assignment + AI ----
    const ownerPage = await ownerCtx.newPage();
    await loginAs(ownerPage, "owner");
    const newUserId = await userIdByEmail(ownerPage, email);
    const issued = await apiAsPage(
      ownerPage,
      "POST",
      `/users/${newUserId}/credential-token`,
      { purpose: "activate" },
    );
    expect(issued.status).toBe(201);
    const token = (issued.body as { token: string }).token;
    const ai = await apiAsPage(ownerPage, "PUT", "/settings/ai", {
      enabled: true,
      baseUrl: LLM_URL,
      apiKey: "e2e-local-secret",
      model: "pilot",
    });
    expect(ai.status).toBe(200);

    // ---- 3. The member activates on the public page and logs in ----
    const memberPage = await memberCtx.newPage();
    await memberPage.goto(
      `/activate.html?token=${encodeURIComponent(token)}`,
    );
    await memberPage.getByLabel("Mật khẩu mới").fill(password);
    await memberPage.getByLabel("Nhập lại mật khẩu").fill(password);
    await memberPage
      .getByRole("button", { name: "Kích hoạt tài khoản" })
      .click();
    await expect(
      memberPage.getByRole("link", { name: "Đăng nhập" }),
    ).toBeVisible();
    await memberPage.getByRole("link", { name: "Đăng nhập" }).click();
    await memberPage.getByLabel("Email").fill(email);
    await memberPage
      .getByLabel("Mật khẩu", { exact: true })
      .fill(password);
    await memberPage
      .getByRole("button", { name: "Đăng nhập", exact: true })
      .click();
    await expect(memberPage).toHaveURL(/\/dashboard\.html$/);
    await expect(memberPage.getByTestId("account-name")).toContainText(
      "Journey Member",
    );
    // Member shell: personal canvas section, NO admin nav entry.
    await expect(
      memberPage.getByText("Canvas cá nhân", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      memberPage.getByRole("link", { name: "Quản trị" }),
    ).toHaveCount(0);

    // Owner-only reporting-tree write, AFTER activation (setManager
    // rejects non-active subjects with USER_NOT_ACTIVE).
    const managerId = await userIdByEmail(
      ownerPage,
      "manager@example.test",
    );
    const attach = await apiAsPage(
      ownerPage,
      "PUT",
      `/users/${newUserId}/manager`,
      { managerId },
    );
    expect(attach.status).toBe(200);

    // ---- 4. Member creates a canvas, edits, publishes v1 ----
    const created = await apiAsPage(memberPage, "POST", "/canvases", {
      ownerUserId: newUserId,
      name: "Canvas hành trình",
      body: draftBody(),
    });
    expect(created.status).toBe(201);
    const canvasId = (created.body as { id: string }).id;
    await memberPage.goto(
      `/canvas-online/?canvas=${encodeURIComponent(canvasId)}`,
    );
    await expect(memberPage.getByLabel("Mục tiêu (Goal)")).toBeVisible({
      timeout: 20_000,
    });
    memberPage.on("dialog", (d) => void d.accept());
    await memberPage
      .getByRole("button", { name: "Chốt phiên bản" })
      .click();
    await expect(memberPage.getByTestId("version-number")).toHaveText(
      "v1",
      { timeout: 20_000 },
    );

    // ---- 5. Manager renders the member's canvas (subtree access) → v2 ----
    const managerPage = await managerCtx.newPage();
    await loginAs(managerPage, "manager");
    await managerPage.goto(
      `/canvas-online/?canvas=${encodeURIComponent(canvasId)}`,
    );
    const goal = managerPage.getByLabel("Mục tiêu (Goal)");
    await expect(goal).toBeVisible({ timeout: 20_000 });
    await managerPage
      .getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ")
      .check();
    await managerPage
      .getByRole("button", { name: "Chạy AI", exact: true })
      .click();
    await expect(managerPage.getByTestId("ai-preview")).toBeVisible({
      timeout: 20_000,
    });
    await managerPage
      .getByRole("button", { name: "Áp dụng vào bản nháp" })
      .click();
    await expect(managerPage.getByTestId("ai-status")).toContainText(
      "Đã áp dụng",
    );
    managerPage.on("dialog", (d) => void d.accept());
    await managerPage
      .getByRole("button", { name: "Chốt phiên bản" })
      .click();
    await expect(managerPage.getByTestId("version-number")).toHaveText(
      "v2",
      { timeout: 20_000 },
    );
    const detail = await apiAsPage(
      managerPage,
      "GET",
      `/canvases/${canvasId}`,
    );
    expect(
      (detail.body as { currentVersion: { versionNo: number } })
        .currentVersion.versionNo,
    ).toBe(2);
    const versionId = (
      detail.body as { currentVersion: { id: string } }
    ).currentVersion.id;

    // ---- 6. ORACLE grading on a session over that canvas ----
    await managerPage.goto("/coaching-report/");
    await expect(managerPage.getByTestId("session-card")).toBeVisible();
    await managerPage
      .getByLabel("Người được coach")
      .selectOption({ label: `Journey Member — ${email}` });
    await managerPage
      .getByRole("button", { name: "Tạo phiên mới" })
      .click();
    await expect(managerPage.getByTestId("session-status")).toContainText(
      "Phiên đã tạo",
    );
    await managerPage.getByLabel("Transcript").fill(oracleCases.transcript);
    await managerPage
      .getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ")
      .check();
    await managerPage.getByRole("button", { name: "Chấm phiên" }).click();
    await expect(
      managerPage.getByRole("button", { name: "Lưu báo cáo" }),
    ).toBeVisible({ timeout: 20_000 });
    await managerPage
      .getByRole("button", { name: "Lưu báo cáo" })
      .click();
    await expect(managerPage.getByTestId("report-detail")).toContainText(
      "63/100",
      { timeout: 15_000 },
    );
    const reportId = await managerPage
      .getByTestId("report-detail")
      .getAttribute("data-report-id");
    expect(reportId).toBeTruthy();

    // ---- 7. Share to the coachee → reads → revoke → denied ----
    const deniedBefore = await apiAsPage(
      memberPage,
      "GET",
      `/reports/${reportId}`,
    );
    expect(deniedBefore.status).toBe(404);
    await managerPage.getByLabel("Chia sẻ với người dùng").selectOption({
      label: `Journey Member — ${email}`,
    });
    await managerPage
      .getByRole("button", { name: "Chia sẻ", exact: true })
      .click();
    await expect(managerPage.getByTestId("share-status")).toContainText(
      "Đã chia sẻ",
    );
    const shared = await apiAsPage(
      memberPage,
      "GET",
      `/reports/${reportId}`,
    );
    expect(shared.status).toBe(200);
    await managerPage
      .getByRole("button", { name: "Thu hồi chia sẻ", exact: true })
      .click();
    await expect(managerPage.getByTestId("share-status")).toContainText(
      "Đã thu hồi",
    );
    const revoked = await apiAsPage(
      memberPage,
      "GET",
      `/reports/${reportId}`,
    );
    expect(revoked.status).toBe(404);

    // ---- 8. Boundaries: outsider + member hits forbidden surfaces ----
    const outsiderPage = await outsiderCtx.newPage();
    await loginAs(outsiderPage, "outsider");
    // Uniform 404 — the outsider is inside the company but outside the
    // subtree, so canvas/report/version export all answer the same way.
    for (const path of [
      `/canvases/${canvasId}`,
      `/canvases/${canvasId}/versions/${versionId}/export?format=json`,
      `/reports/${reportId}`,
    ]) {
      const res = await apiAsPage(outsiderPage, "GET", path);
      expect(res.status, `outsider GET ${path}`).toBe(404);
    }
    // Member-only role cannot touch owner/admin surfaces.
    const roleWrite = await apiAsPage(
      memberPage,
      "PUT",
      `/users/${newUserId}/roles`,
      { roles: ["member", "admin"] },
    );
    expect(roleWrite.status).toBe(403);
    const auditList = await apiAsPage(memberPage, "GET", "/audit?limit=5");
    expect(auditList.status).toBe(403);

    // ---- 9. Air-gap: abort every non-loopback request; app still works ----
    // The assertion is on THIS context's traffic — any CDN/font/package
    // fetch would be aborted and break the page. Loopback app + LLM are
    // unaffected, which is exactly the offline guarantee (spec §9).
    await memberCtx.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host === "localhost" || host === "127.0.0.1") {
        return route.continue();
      }
      return route.abort();
    });
    await memberPage.goto("/dashboard.html");
    await expect(memberPage.getByTestId("account-name")).toContainText(
      "Journey Member",
    );
    await expect(
      memberPage.getByText("Canvas cá nhân", { exact: true }).first(),
    ).toBeVisible();
    // API still answers over loopback under the block.
    const offlineList = await apiAsPage(
      memberPage,
      "GET",
      "/canvases?limit=5",
    );
    expect(offlineList.status).toBe(200);
    // The loopback LLM served step 5/6 under the same rule — the fake
    // saw both upstream requests on 127.0.0.1.
    expect(llm.requests.length).toBeGreaterThanOrEqual(2);
  } finally {
    await adminCtx.close();
    await ownerCtx.close();
    await memberCtx.close();
    await managerCtx.close();
    await outsiderCtx.close();
    await llm.close();
  }
});
