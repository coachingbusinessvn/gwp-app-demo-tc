export type DemoMode = "demo" | "production";

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  appKey: string;
  bootstrapToken: string;
  mode: DemoMode;
  appOrigin: string;
  port: number;
  trustProxy: boolean | number | string;
}

const REQUIRED = [
  "DATABASE_URL",
  "JWT_SECRET",
  "APP_KEY",
  "BOOTSTRAP_TOKEN",
  "APP_ORIGIN",
] as const;

const MIN_SECRET_LENGTH = 32;

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

  const databaseUrl = requireEnv(env, "DATABASE_URL");
  let dbScheme: string;
  try {
    dbScheme = new URL(databaseUrl).protocol.replace(/:$/, "");
  } catch {
    fail("DATABASE_URL is not a valid URL");
  }
  if (dbScheme !== "postgres" && dbScheme !== "postgresql")
    fail(`DATABASE_URL must be a postgres:// URL, got scheme "${dbScheme}"`);

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

  if (env.NODE_ENV === "production") {
    const weak = (
      [
        ["JWT_SECRET", jwtSecret],
        ["APP_KEY", appKey],
        ["BOOTSTRAP_TOKEN", bootstrapToken],
      ] as const
    ).filter(([, v]) => v.length < MIN_SECRET_LENGTH);
    if (weak.length > 0)
      fail(
        `weak secrets rejected under NODE_ENV=production: ${weak
          .map(([k]) => `${k} < ${MIN_SECRET_LENGTH} chars`)
          .join(", ")}`,
      );
  }

  return {
    databaseUrl,
    jwtSecret,
    appKey,
    bootstrapToken,
    mode,
    appOrigin,
    port: parsePort(env.PORT),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
