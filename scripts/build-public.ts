/**
 * Public build (task 0.5, spec §2): the ONLY directory the server ever
 * serves is public-build/, and it contains ONLY this allowlist:
 *
 *   index.html dashboard.html employee.html canvas.html
 *   admin.html activate.html
 *   assets/gwp.css assets/fonts.css assets/app.js assets/fonts/*
 *   web/api.js web/auth.js web/activate.js web/admin/* web/canvas/*
 *   canvas-online/  (task 2.5 — the real canvas editor page)
 *
 * web/*.js, web/admin/*.js, web/canvas/*.js and assets/app.js are already
 * browser-ready ESM (no TypeScript, no bare specifiers beyond relative
 * paths), so a verified plain copy is correct — when Phase 2 adds
 * shared/canvas TypeScript entrypoints they get bundled through esbuild
 * here instead. TS sources are never served.
 *
 * Deliberately excluded: assets/data.js + assets/export.js (demo-era),
 * coaching-report/, docs/, server/, tests/, node_modules,
 * .env*, *.md — anything not on the list stays unserved.
 *
 * `npm run build` = tsx scripts/build-public.ts && tsc -p tsconfig.build.json.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outDir = path.join(repoRoot, "public-build");

const ALLOWLIST_FILES = [
  "index.html",
  "dashboard.html",
  "employee.html",
  "canvas.html",
  "admin.html",
  "activate.html",
  "assets/gwp.css",
  "assets/fonts.css",
  "assets/app.js",
  "web/api.js",
  "web/auth.js",
  "web/activate.js",
] as const;

/** Whole directories copied verbatim (locally bundled fonts + license,
 * the admin page's flat ESM module directory, and the canvas editor
 * modules + page — task 2.5). */
const ALLOWLIST_DIRS = [
  "assets/fonts",
  "web/admin",
  "web/canvas",
  "web/ai",
  "canvas-online",
] as const;

export function buildPublic(): string[] {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  for (const rel of ALLOWLIST_FILES) {
    const src = path.join(repoRoot, rel);
    if (!existsSync(src) || !statSync(src).isFile()) {
      throw new Error(`build-public: allowlisted source missing: ${rel}`);
    }
    const dest = path.join(outDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
    written.push(rel);
  }
  for (const dir of ALLOWLIST_DIRS) {
    const src = path.join(repoRoot, dir);
    if (!existsSync(src)) continue; // fonts dir optional until bundled
    for (const entry of readdirSync(src)) {
      const rel = `${dir}/${entry}`;
      const from = path.join(src, entry);
      if (!statSync(from).isFile()) continue;
      const dest = path.join(outDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(from, dest);
      written.push(rel);
    }
  }
  return written;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const written = buildPublic();
  console.log(
    `build-public: wrote ${written.length} file(s) to ${path.relative(process.cwd(), outDir)}/`,
  );
}
