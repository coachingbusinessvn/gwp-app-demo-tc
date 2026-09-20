import knex, { type Knex } from "knex";

export interface CreateDbOptions {
  /**
   * Restrict every pooled connection to this schema via `SET search_path`
   * applied in pool.afterCreate. Used by the test fixture for per-file schema
   * isolation; production code leaves it unset.
   */
  searchPath?: string;
  /** Pool ceiling — tests pass a small value so parallel fixtures cannot
   * exhaust the disposable container's max_connections. Default 10. */
  poolMax?: number;
}

/** Runtime Knex connection (PostgreSQL is the only supported engine). */
export function createDb(url: string, options?: CreateDbOptions): Knex {
  const searchPath = options?.searchPath;
  return knex({
    client: "pg",
    connection: { connectionString: url },
    pool: {
      min: 0,
      max: options?.poolMax ?? 10,
      ...(searchPath
        ? {
            afterCreate: (
              conn: { query: (sql: string, cb: (err: unknown) => void) => void },
              done: (err: unknown, conn: unknown) => void,
            ) => {
              // Schema names come from fixture-generated uuids; quoting is
              // defence-in-depth anyway.
              conn.query(
                `SET search_path TO "${searchPath}"`,
                (err: unknown) => done(err, conn),
              );
            },
          }
        : {}),
    },
  });
}
