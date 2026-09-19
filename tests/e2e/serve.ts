import { execFileSync } from "node:child_process";
import { E2E_REPO_ROOT, provisionE2eDatabase } from "./e2e-db.js";

/**
 * Playwright webServer entrypoint (task 0.5). Playwright starts webServer
 * before globalSetup, so everything the app needs is provisioned HERE, in
 * order: dedicated gwp_e2e database → real public-build/ → the actual
 * server (imported for its top-level listen; env comes from
 * playwright.config.ts webServer.env).
 */
await provisionE2eDatabase();
execFileSync("npx", ["tsx", "scripts/build-public.ts"], {
  cwd: E2E_REPO_ROOT,
  stdio: "inherit",
});
await import("../../server/src/index.js");
