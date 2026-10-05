import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllowedHosts, type AllowEntry } from "./security/ai-destination.js";
import { parseKeyRing, type KeyRingEntry } from "./security/secrets.js";

export type DemoMode = "demo" | "production";

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  appKey: string;
  /**
   * APP_KEY parsed once at boot into a versioned ring (security/secrets.ts):
   * the highest version encrypts, every retained version decrypts.
   */
  appKeyRing: KeyRingEntry[];
  bootstrapToken: string;
  mode: DemoMode;
  appOrigin: string;
  port: number;
  trustProxy: boolean | number | string;
  /**
   * Operator allowlist for the BYOK AI base URL host:port pairs (spec §7.1).
   * Empty means no destination is permitted — saving AI settings then always
   * 400s, which is the safe default for a deployment without a local LLM.
   */
  aiAllowedHosts: AllowEntry[];
  /** Explicit operator opt-in for http:// AI destinations (trusted nets). */
  aiAllowHttp: boolean;
  /** Access JWT lifetime — spec §8 default 10 minutes. */
  accessTokenTtlSeconds: number;
  /** Refresh session absolute lifetime — spec §8 max 7 days. */
  refreshTokenTtlSeconds: number;
  /** HttpOnly cookie carrying the rotating refresh token. */
  refreshCookieName: string;
  /** JS-readable cookie mirrored by the X-CSRF-Token header. */
  csrfCookieName: string;
  /**
   * Directory the static middleware serves — always the allowlisted
   * `<repo>/public-build` produced by scripts/build-public.ts, NEVER the
   * repository root (spec §2: only built public assets are served).
   */
  publicDir: string;
}

const REQUIRED = [
  "DATABASE_URL",
  "JWT_SECRET",
  "APP_KEY",
  "BOOTSTRAP_TOKEN",
  "APP_ORIGIN",
] as const;

const MIN_SECRET_LENGTH = 32;

/** Markers of the copy-paste dummies in .env.example — those values are
 * public, so a production boot with one of them is a forgeable deployment
 * even though it passes the length floor. */
const PLACEHOLDER_SECRET = /change[-_]?me|dummy/i;

/**
 * Repository root = the nearest ancestor containing package.json. Works from
 * both source layout (server/src/config.ts → ../..) and the compiled layout
 * (dist/server/src/config.js walks past dist/ to the same root) so
 * publicDir always lands at <repo>/public-build regardless of entrypoint.
 */
export function resolveRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Unreachable in this repo; fall back to the source-layout resolution.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function fail(message: string): never {
  throw new Error(`config: ${message}`);
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") fail(`missing required env ${key}`);
  return value;
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail(`PORT must be an integer between 1 and 65535, got "${raw}"`);
  return port;
}

function parsePositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    fail(`${key} must be a positive integer, got "${raw}"`);
  return n;
}

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === "" || raw === "false" || raw === "0")
    return false;
  if (raw === "true" || raw === "1") return true;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  return raw; // CIDR / named range such as "loopback" — passed to Express verbatim.
}

/**
 * Validate process.env into a typed Config. Throws on missing/invalid input —
 * config errors are fatal at boot. When NODE_ENV=production the three secrets
 * must each be at least 32 characters.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0)
    fail(`missing required env: ${missing.join(", ")}`);

  // The app intentionally never carries the migrator credential:
  // MIGRATOR_DATABASE_URL is consumed only by db/migrate.ts's CLI
  // (resolveMigratorUrl), so a malformed value cannot break app boot.
  const databaseUrl = requireEnv(env, "DATABASE_URL");
  const assertPostgresUrl = (key: string, value: string): void => {
    let scheme: string;
    try {
      scheme = new URL(value).protocol.replace(/:$/, "");
    } catch {
      fail(`${key} is not a valid URL`);
    }
    if (scheme !== "postgres" && scheme !== "postgresql")
      fail(`${key} must be a postgres:// URL, got scheme "${scheme}"`);
  };
  assertPostgresUrl("DATABASE_URL", databaseUrl);

  const appOrigin = requireEnv(env, "APP_ORIGIN");
  let origin: URL;
  try {
    origin = new URL(appOrigin);
  } catch {
    fail(`APP_ORIGIN is not a valid URL: "${appOrigin}"`);
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:")
    fail(`APP_ORIGIN must be an http(s) origin, got "${appOrigin}"`);

  const mode = env.DEMO_MODE ?? "production";
  if (mode !== "demo" && mode !== "production")
    fail(`DEMO_MODE must be "demo" or "production", got "${mode}"`);

  const jwtSecret = requireEnv(env, "JWT_SECRET");
  const appKey = requireEnv(env, "APP_KEY");
  const bootstrapToken = requireEnv(env, "BOOTSTRAP_TOKEN");

  // Fail fast on a malformed key ring or allowlist at boot, not on the
  // first AI settings write (config errors are fatal by convention).
  const appKeyRing = parseKeyRing(appKey);
  const aiAllowedHosts = parseAllowedHosts(env.AI_ALLOWED_HOSTS);
  const aiAllowHttp = env.AI_ALLOW_HTTP === "true";

  if (env.NODE_ENV === "production") {
    const weak = (
      [
        ["JWT_SECRET", jwtSecret],
        ["APP_KEY", appKey],
        ["BOOTSTRAP_TOKEN", bootstrapToken],
      ] as const
    ).flatMap(([k, v]) =>
      v.length < MIN_SECRET_LENGTH
        ? [`${k} < ${MIN_SECRET_LENGTH} chars`]
        : PLACEHOLDER_SECRET.test(v)
          ? [`${k} is a .env.example placeholder`]
          : [],
    );
    if (weak.length > 0)
      fail(
        `weak secrets rejected under NODE_ENV=production: ${weak.join(", ")}`,
      );
  }

  return {
    databaseUrl,
    jwtSecret,
    appKey,
    appKeyRing,
    bootstrapToken,
    mode,
    appOrigin,
    port: parsePort(env.PORT),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    aiAllowedHosts,
    aiAllowHttp,
    accessTokenTtlSeconds: parsePositiveInt(
      env,
      "ACCESS_TOKEN_TTL_SECONDS",
      600,
    ),
    refreshTokenTtlSeconds: parsePositiveInt(
      env,
      "REFRESH_TOKEN_TTL_SECONDS",
      604_800,
    ),
    refreshCookieName: "gwp_refresh",
    csrfCookieName: "gwp_csrf",
    publicDir: path.join(resolveRepoRoot(), "public-build"),
  };
}
