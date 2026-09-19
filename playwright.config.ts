import { defineConfig } from "@playwright/test";
import { E2E_URLS } from "./tests/e2e/e2e-db.js";

/**
 * Real e2e for task 0.5: Playwright boots the actual app server via
 * tests/e2e/serve.ts (provisions the dedicated gwp_e2e database + builds
 * public-build/ first, then imports server/src/index.ts) on a fixed port —
 * never the vitest gwp_test schemas and never a production DATABASE_URL.
 *
 * APP_ORIGIN must equal the served origin exactly: refresh/logout require
 * `Origin === config.appOrigin` (requireOrigin middleware, spec §8).
 * Secure+SameSite=Strict cookies work on http://localhost in Chromium —
 * localhost is a potentially trustworthy origin.
 */
const E2E_PORT = 8901;
const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // Serial workers: the suite shares one seeded DB and login is rate-limited
  // per account+IP (5/min) — parallel logins of one persona could trip it.
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: E2E_ORIGIN,
    actionTimeout: 15_000,
  },
  webServer: {
    command: "npx tsx tests/e2e/serve.ts",
    url: `${E2E_ORIGIN}/health/ready`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: E2E_URLS.runtime,
      JWT_SECRET: "e2e-jwt-secret-0123456789abcdef0123456789",
      APP_KEY: "e2e-app-key-0123456789abcdef0123456789",
      BOOTSTRAP_TOKEN: "e2e-bootstrap-token-0123456789abcdef",
      DEMO_MODE: "demo",
      APP_ORIGIN: E2E_ORIGIN,
      PORT: String(E2E_PORT),
      TRUST_PROXY: "false",
    },
  },
});
