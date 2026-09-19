import type { Knex } from "knex";

/**
 * Disposable-target guards for destructive test setup. Any code path that
 * drops or recreates database objects for tests — fixture schema teardown
 * inside gwp_test, e2e DROP/CREATE DATABASE gwp_e2e — must prove TWICE that
 * it is aimed at the disposable compose.test.yaml container and nothing
 * else:
 *   1. the connection URL's shape (scheme, host/port, database name),
 *   2. `SELECT current_database()` on the live connection.
 * Env overrides are honored only after passing both checks; a pointed-at
 * non-test server must fail closed with the offending env var named.
 */

const DISPOSABLE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DISPOSABLE_PORT = "54329";

export function assertDisposableDbUrl(
  url: string,
  opts: {
    /** Env var named in error messages. */
    envVar: string;
    /** Required database name in the URL path ("gwp_test", "gwp_e2e"). */
    dbName: string;
    /**
     * When true the URL must also target the disposable container
     * host:port — required before destructive DDL (DROP/CREATE DATABASE).
     * The vitest fixture keeps name-only checks so an alternate disposable
     * container mapping still works; e2e teardown sets this.
     */
    requireContainerHost?: boolean;
  },
): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${opts.envVar} is not a valid URL: "${url}"`);
  }
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme !== "postgres" && scheme !== "postgresql") {
    throw new Error(
      `${opts.envVar} must be a postgres:// URL, got scheme "${scheme}"`,
    );
  }
  if (
    opts.requireContainerHost &&
    (!DISPOSABLE_HOSTS.has(u.hostname) || u.port !== DISPOSABLE_PORT)
  ) {
    throw new Error(
      `${opts.envVar} must target the disposable test container ` +
        `(127.0.0.1/localhost:${DISPOSABLE_PORT}), got ` +
        `"${u.hostname}:${u.port || "(default)"}" — ` +
        "refusing destructive setup against a non-test target",
    );
  }
  const dbName = u.pathname.replace(/^\//, "");
  if (dbName !== opts.dbName) {
    throw new Error(
      `${opts.envVar} must use database "${opts.dbName}", got "${dbName}"`,
    );
  }
}

export async function assertConnectedToDisposableDb(
  db: Knex,
  expectedDb: string,
): Promise<void> {
  const { rows } = await db.raw("select current_database() as name");
  if (rows[0]?.name !== expectedDb) {
    throw new Error(
      `refusing destructive test setup: connected to database ` +
        `"${rows[0]?.name}", expected "${expectedDb}"`,
    );
  }
}
