import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/connection.js";
import { assertDeploymentMode } from "./db/deployment-state.js";

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl);

// Refuse to boot when the database was provisioned for a different mode —
// DEMO_MODE is an immutable property of the DB, not a runtime toggle (§8).
try {
  await assertDeploymentMode(db, config);
} catch (err) {
  console.error(
    "startup check failed:",
    err instanceof Error ? err.message : err,
  );
  await db.destroy().catch(() => {});
  process.exit(1);
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
