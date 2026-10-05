import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import type { Knex } from "knex";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { createDb } from "../../server/src/db/connection.js";
import { TEST_DATABASE_URL, testEnv } from "../helpers/fixture.js";

/**
 * Public asset boundary (task 0.5, spec §2): only the allowlisted
 * public-build/ output is ever served — source, secrets, docs, fixtures and
 * demo-era data modules must 404 through the mounted static middleware.
 *
 * Choice documented per brief: the test runs the REAL build
 * (`tsx scripts/build-public.ts`) in beforeAll and points the app at the
 * real public-build via config.publicDir (its default), so the boundary is
 * asserted against the actual shipped artifact — not a hand-made temp dir.
 * No static request touches the DB, but the Knex handle is real anyway.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

let app: Express;
let db: Knex | undefined;

beforeAll(async () => {
  execFileSync("npx", ["tsx", "scripts/build-public.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const config = loadConfig(testEnv);
  expect(config.publicDir).toBe(path.join(repoRoot, "public-build"));
  db = createDb(TEST_DATABASE_URL);
  app = createApp({ db, clock: () => new Date(), config });
}, 60_000);

afterAll(async () => {
  await db?.destroy().catch(() => {});
});

const FORBIDDEN_PATHS = [
  "/.env",
  "/server/src/config.ts",
  "/docs/superpowers/specs/2026-09-19-gwp-app-real-design.md",
  "/assets/data.js", // demo-era fixture data — excluded from the build
  "/assets/export.js", // demo-era export helpers — excluded
  "/package.json",
  "/compose.test.yaml",
  "/tests/helpers/fixture.ts",
  "/node_modules/express/package.json",
  "/scripts/build-public.ts",
];

describe("static boundary — repository is never served", () => {
  it.each(FORBIDDEN_PATHS)("%s → 404 NOT_FOUND", async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("path traversal cannot escape publicDir", async () => {
    for (const p of [
      "/../server/src/config.ts",
      "/..%2f..%2fserver%2fsrc%2fconfig.ts",
      "/assets/../../package.json",
    ]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404);
    }
  });
});

const ALLOWED_PATHS = [
  "/index.html",
  "/dashboard.html",
  "/employee.html",
  "/canvas.html",
  "/assets/gwp.css",
  "/assets/app.js",
  "/web/api.js",
  "/web/auth.js",
  // Task 2.5 — the canvas editor ships in the public build.
  "/canvas-online/index.html",
  "/web/canvas/editor.js",
  "/web/canvas/model.js",
  "/web/canvas/autosave.js",
  "/web/canvas/diff.js",
  "/web/canvas/history.js",
  "/web/canvas/logo.js",
  // Account self-service + the shared app shell (header/nav/branding).
  "/account.html",
  "/web/account.js",
  "/web/shell.js",
  "/web/shell-model.js",
  "/coaching-report/index.html",
];

describe("static boundary — allowlisted public build is served", () => {
  it.each(ALLOWED_PATHS)("%s → 200", async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
  });

  it("GET /index.html serves HTML", async () => {
    const res = await request(app).get("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Đăng nhập");
  });

  it("account.html ships as HTML with only the external module script (CSP)", async () => {
    const res = await request(app).get("/account.html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Đổi mật khẩu");
    // script-src 'self': every <script> must be an external src, never inline.
    const scripts = res.text.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script type="module" src="web/account.js">']);
  });

  it("hero-header pages include the shared shell module", async () => {
    for (const p of ["/canvas-online/index.html", "/coaching-report/index.html"]) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(200);
      expect(res.text, p).toContain('<script type="module" src="/web/shell.js">');
      expect(res.text, p).toContain("data-shell-nav");
    }
  });

  it("GET / redirects to the login page (explicit route, not index serving)", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/index.html");
  });

  it("directory requests do not auto-serve index (index:false)", async () => {
    // /web/ exists in the build — a directory hit must still fall through
    // to the JSON 404; only the two explicit routes (/ and /canvas-online)
    // are exempt.
    const res = await request(app).get("/web/");
    expect(res.status).toBe(404);
  });

  it("/canvas-online/ serves the built editor via its explicit route", async () => {
    for (const p of ["/canvas-online", "/canvas-online/"]) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    }
  });

  it("unknown /api/v1/* still returns the JSON NOT_FOUND envelope", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });
});
