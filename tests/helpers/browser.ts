import { expect, type BrowserContext, type Page } from "@playwright/test";
import {
  FIXTURE_PASSWORD,
  personaEmail,
  type Persona,
} from "./seed-personas.js";

/**
 * The auth rate limiters are per-IP (spec §8): the whole e2e suite runs on
 * 127.0.0.1, so without a distinct client IP per browser context the
 * refresh/logout sessionLimiter (30/min) trips mid-suite and sessions start
 * failing for rate reasons — not auth reasons. The e2e server runs
 * TRUST_PROXY=loopback (playwright.config.ts), so a unique X-Forwarded-For
 * per context makes each test look like its own client — the same shape a
 * real multi-client deployment presents. Call before the first request of a
 * context (loginAs does this for you).
 */
let clientIpSeq = 0;
export async function isolateClientIp(
  target: Page | BrowserContext,
): Promise<void> {
  clientIpSeq += 1;
  const context = "context" in target ? target.context() : target;
  await context.setExtraHTTPHeaders({
    "X-Forwarded-For": `10.255.${Math.floor(clientIpSeq / 250)}.${(clientIpSeq % 250) + 1}`,
  });
}

/**
 * Browser login helper (task 1.5): drives the REAL login form on
 * index.html with the fixture persona credentials — never a fabricated
 * token, a storage shortcut or a test backdoor — then waits for the
 * post-login redirect to the account shell, so callers always start from
 * a fully authenticated page.
 */
export async function loginAs(page: Page, persona: Persona): Promise<void> {
  await isolateClientIp(page);
  await page.goto("/index.html");
  await page.getByLabel("Email").fill(personaEmail(persona));
  await page
    .getByLabel("Mật khẩu", { exact: true })
    .fill(FIXTURE_PASSWORD);
  await page
    .getByRole("button", { name: "Đăng nhập", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard\.html$/);
  // The account-shell chrome is up once the identity block rendered.
  await expect(page.getByTestId("account-name")).toBeVisible();
}

/**
 * JSON API call routed through the page's REAL apiFetch module (in-memory
 * Bearer token + CSRF double-submit + one-flight refresh) — the same code
 * path the admin UI uses. Returns {status, body} with body JSON-parsed or
 * null for empty responses.
 */
export async function apiAsPage(
  page: Page,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ([m, p, b]) => {
      const specifier = "/web/api.js";
      const { apiFetch } = (await import(specifier)) as {
        apiFetch: (
          path: string,
          init?: { method?: string; headers?: Record<string, string>; body?: string },
        ) => Promise<{ status: number; text(): Promise<string> }>;
      };
      const res = await apiFetch(p, {
        method: m,
        headers: b === undefined ? {} : { "Content-Type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      return { status: res.status, body: text === "" ? null : JSON.parse(text) };
    },
    [method, path, body] as const,
  );
}
