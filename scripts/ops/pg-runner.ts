import { spawnSync, type SpawnSyncOptions } from "node:child_process";

/**
 * Shared plumbing for the ops scripts (task 0.6, spec §9).
 *
 * Resolution order for running PostgreSQL client tools:
 *   1. binaries on PATH (container case — the runtime image installs
 *      postgresql-client, and operators may have the tools locally);
 *   2. `docker compose -f <file> exec -T <service> <tool>` fallback — for a
 *      dev host without client tools, where the database lives inside a
 *      compose service with no published port.
 *
 * Which compose file/service: env GWP_OPS_COMPOSE_FILE / GWP_OPS_DB_SERVICE
 * (defaults compose.yaml / db — the deployment bundle). The vitest suite
 * overrides them to compose.test.yaml / test-db.
 *
 * Security rules: never log a URL or password — credentials travel only via
 * PGPASSWORD in the spawned child's environment, and for compose mode via
 * `docker compose exec -e PGPASSWORD` passthrough so the value never
 * appears in argv.
 */

export interface PgTarget {
  /** Original URL — NEVER log it (contains the password). */
  url: string;
  user: string;
  password: string;
  host: string;
  port: string;
  /** Database name from the URL path. */
  dbName: string;
}

export function parsePgUrl(raw: string, what: string): PgTarget {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} is not a valid URL`);
  }
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme !== "postgres" && scheme !== "postgresql") {
    throw new Error(`${what} must be a postgres:// URL, got "${scheme}"`);
  }
  const dbName = u.pathname.replace(/^\//, "");
  if (dbName === "") {
    throw new Error(`${what} must name a database in its path`);
  }
  return {
    url: raw,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port || "5432",
    dbName,
  };
}

function onPath(bin: string): boolean {
  const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
  return res.status === 0;
}

export type PgRunner =
  | { kind: "local" }
  | { kind: "compose"; composeFile: string; service: string };

export interface ResolveRunnerOptions {
  /** Binaries that must ALL exist on PATH for the local runner to win. */
  tools: string[];
  /** Overrides for the compose fallback (flags already parsed by caller). */
  composeFile?: string;
  dbService?: string;
}

export function resolvePgRunner(options: ResolveRunnerOptions): PgRunner {
  if (options.tools.every(onPath)) return { kind: "local" };
  return {
    kind: "compose",
    composeFile:
      options.composeFile ??
      process.env.GWP_OPS_COMPOSE_FILE ??
      "compose.yaml",
    service:
      options.dbService ?? process.env.GWP_OPS_DB_SERVICE ?? "db",
  };
}

/**
 * Compose-mode argv prefix: `docker compose -f <file> exec -T -e PGPASSWORD
 * <service> <tool...>`. PGPASSWORD is forwarded from the child env — never
 * expanded into argv.
 */
export function composeExecArgv(
  runner: Extract<PgRunner, { kind: "compose" }>,
  argv: string[],
): string[] {
  return [
    "compose",
    "-f",
    runner.composeFile,
    "exec",
    "-T",
    "-e",
    "PGPASSWORD",
    runner.service,
    ...argv,
  ];
}

/**
 * Run a command, streaming the child's stderr to ours. Returns the exit
 * status. `stdoutFile` (an fd) receives stdout when set (pg_dump binary
 * output); otherwise stdout is piped and returned as a string.
 */
export function runTool(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; stdoutFd?: number } = {},
): { status: number; stdout: string } {
  const opts: SpawnSyncOptions = {
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", options.stdoutFd ?? "pipe", "inherit"],
  };
  const res = spawnSync(argv[0], argv.slice(1), opts);
  if (res.error) throw res.error;
  const stdout =
    typeof res.stdout === "string"
      ? res.stdout
      : (res.stdout?.toString("utf8") ?? "");
  return { status: res.status ?? 1, stdout };
}

/** Child env with the password — the only place PGPASSWORD is set. */
export function envWithPassword(target: PgTarget): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: target.password };
}
