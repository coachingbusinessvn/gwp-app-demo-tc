import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/connection.js";

const config = loadConfig(process.env);
const db = createDb(config.databaseUrl);
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
