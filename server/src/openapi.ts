import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { resolveRepoRoot } from "./config.js";

/**
 * OpenAPI serving (task 0.6, spec §2): the hand-maintained contract in
 * server/openapi.yaml is parsed ONCE and served verbatim as JSON at
 * GET /api/v1/openapi.json. Read+parse at startup keeps a single YAML source
 * of truth — the file is copied into the runtime image at
 * <repoRoot>/server/openapi.yaml, and a missing/invalid document fails the
 * boot rather than serving a broken spec.
 */
let cached: Record<string, unknown> | undefined;

export function loadOpenApiSpec(): Record<string, unknown> {
  if (cached === undefined) {
    const file = path.join(resolveRepoRoot(), "server", "openapi.yaml");
    const doc = parse(readFileSync(file, "utf8")) as unknown;
    if (
      doc === null ||
      typeof doc !== "object" ||
      typeof (doc as { openapi?: unknown }).openapi !== "string"
    ) {
      throw new Error(`openapi: ${file} did not parse to an OpenAPI document`);
    }
    cached = doc as Record<string, unknown>;
  }
  return cached;
}
