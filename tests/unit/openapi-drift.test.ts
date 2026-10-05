import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * OpenAPI is hand-maintained (server/openapi.yaml) and is the contract the
 * future API/MCP/mobile clients code against — so every /api/v1 route a
 * module router declares must be documented, and every documented
 * operation must exist. Source scan (not runtime introspection): module
 * routers declare literal paths, and each mounts at /api/v1 except auth.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulesDir = path.join(repoRoot, "server/src/modules");
const MOUNT: Record<string, string> = { "auth/routes.ts": "/api/v1/auth" };
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
/** Routes registered in a loop (auth/routes.ts `for (const [path, …] of
 * [["/activate", …], ["/reset", …]])`) — listed here, and the test below
 * asserts their path literal still exists so this list can't go stale. */
const DYNAMIC: Record<string, string> = {
  "POST /api/v1/auth/activate": '["/activate"',
  "POST /api/v1/auth/reset": '["/reset"',
};

function declaredRoutes(): Set<string> {
  const out = new Set<string>();
  for (const mod of readdirSync(modulesDir)) {
    let files: string[];
    try {
      files = readdirSync(path.join(modulesDir, mod)).filter((f) =>
        /routes\.ts$/.test(f),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = `${mod}/${file}`;
      const prefix = MOUNT[rel] ?? "/api/v1";
      const src = readFileSync(path.join(modulesDir, rel), "utf8");
      const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
      for (const m of src.matchAll(re)) {
        // Express ":param" → OpenAPI "{param}".
        const p = (prefix + m[2]).replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        out.add(`${m[1].toUpperCase()} ${p}`);
      }
    }
  }
  const authSrc = readFileSync(path.join(modulesDir, "auth/routes.ts"), "utf8");
  for (const [route, literal] of Object.entries(DYNAMIC)) {
    if (authSrc.includes(literal)) out.add(route);
  }
  return out;
}

function documentedRoutes(): Set<string> {
  const spec = parse(
    readFileSync(path.join(repoRoot, "server/openapi.yaml"), "utf8"),
  ) as { paths: Record<string, Record<string, unknown>> };
  const out = new Set<string>();
  for (const [p, ops] of Object.entries(spec.paths)) {
    if (!p.startsWith("/api/v1/") || p === "/api/v1/openapi.json") continue;
    for (const method of Object.keys(ops)) {
      if ((METHODS as readonly string[]).includes(method))
        out.add(`${method.toUpperCase()} ${p}`);
    }
  }
  return out;
}

describe("OpenAPI ↔ routes drift", () => {
  const declared = declaredRoutes();
  const documented = documentedRoutes();

  it("finds the module routes (scanner sanity)", () => {
    expect(declared.size).toBeGreaterThan(40);
    expect(declared).toContain("POST /api/v1/auth/login");
  });

  it("documents every declared /api/v1 route", () => {
    expect([...declared].filter((r) => !documented.has(r)).sort()).toEqual([]);
  });

  it("declares every documented /api/v1 operation", () => {
    expect([...documented].filter((r) => !declared.has(r)).sort()).toEqual([]);
  });
});
