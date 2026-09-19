import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/connection.js";
import { assertDeploymentMode } from "./db/deployment-state.js";
import { migrationStatus } from "./db/migrate.js";

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl);

// Boot guard (spec §8/§9): a recorded deployment mode that disagrees with
// DEMO_MODE stays fatal — silently serving a production DB as "demo" (or
// vice versa) is worse than being down. But when the database is simply
// unmigrated or unreachable (the one-shot compose migrator may still be
// running, or Postgres may be mid-start), the app still serves: liveness
// stays 200 and /health/ready reports 503 until migrations land — which is
// exactly what orchestrators probe, and the process self-heals without a
// restart once db:migrate completes.
try {
  await assertDeploymentMode(db, config);
} catch (err) {
  const pending = await migrationStatus(db)
    .then((s) => s.pending.length)
    .catch(() => Number.POSITIVE_INFINITY);
  const recordedMode = await db("deployment_state")
    .select("mode")
    .where({ singleton_id: 1 })
    .first()
    .then((row) => (row ? String(row.mode) : undefined))
    .catch(() => undefined);

  // Fatal: deployment_state readable AND its mode disagrees, OR the DB is
  // fully migrated yet the state check still failed (corrupt singleton).
  const realMismatch =
    recordedMode !== undefined && recordedMode !== config.mode;
  if (realMismatch || pending === 0) {
    console.error(
      "startup check failed:",
      err instanceof Error ? err.message : err,
    );
    await db.destroy().catch(() => {});
    process.exit(1);
  }
  console.error(
    "database unmigrated or unreachable — serving degraded: " +
      "/health/ready will report 503 until db:migrate completes",
  );
}

const app = createApp({ db, clock: () => new Date(), config });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    `gwp server listening on 0.0.0.0:${config.port} (mode=${config.mode})`,
  );
});

let shuttingDown = false;

// Graceful shutdown: stop accepting connections, drain in-flight requests,
// then release the pool.
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — draining connections`);
  const force = setTimeout(() => {
    console.error("drain timed out — forcing exit");
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    void db
      .destroy()
      .catch(() => {})
      .finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
