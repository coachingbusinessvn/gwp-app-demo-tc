import type { Knex } from "knex";
import type { Config } from "../config.js";

/**
 * Startup guard (spec §8): DEMO_MODE is an immutable property of the
 * database, recorded in the deployment_state singleton at migration time.
 * Boot must REFUSE when the DB's recorded mode disagrees with the process
 * config — silently serving a production DB as "demo" (or vice versa) is
 * worse than being down.
 *
 * Called by index.ts before listen; also usable from tests to simulate a
 * restart against a mismatched database.
 */
export async function assertDeploymentMode(
  db: Knex,
  config: Config,
): Promise<void> {
  const state = await db("deployment_state")
    .select("mode")
    .where({ singleton_id: 1 })
    .first();
  if (!state) {
    throw new Error(
      "deployment_state singleton is missing — run db:migrate before starting the app",
    );
  }
  if (state.mode !== config.mode) {
    throw new Error(
      `deployment mode mismatch: database is "${state.mode}" but DEMO_MODE is "${config.mode}" — refusing to start`,
    );
  }
}
