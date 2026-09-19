import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";
import { createDb } from "../../server/src/db/connection.js";
import { migrate, MIGRATIONS, migrationStatus } from "../../server/src/db/migrate.js";
import {
  assertConnectedToDisposableDb,
  assertDisposableDbUrl,
} from "../helpers/disposable-db.js";
import {
  FIXTURE_PASSWORD,
  fixture,
  TEST_DATABASE_URL,
  TEST_MAINTENANCE_DATABASE_URL,
  TEST_MIGRATOR_DATABASE_URL,
  testEnv,
} from "../helpers/fixture.js";

/**
 * Deployment bundle checks (task 0.6, spec §2/§9):
 *  - compose.yaml parses under `docker compose config` and never publishes
 *    the Postgres port — the DB is internal-network only;
 *  - the served OpenAPI document covers the Phase-0 surface and carries no
 *    secrets/example credentials;
 *  - liveness stays 200 while readiness reports 503 on DB-down and on
 *    pending migrations; the migrator is idempotent;
 *  - ops:backup → ops:restore-test round-trip works against the disposable
 *    test Postgres (pg tools absent on this host → the compose-exec
 *    fallback path is what gets exercised here);
 *  - ops:restore-test refuses a non-disposable target without
 *    --i-understand.
 *
 * The heavy `docker compose up --build` smoke is operator-run (see
 * docs/operations/foundation.md) — vitest only validates the compose FILE.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// Point the ops scripts' compose-exec fallback at the disposable test stack.
const OPS_ENV = {
  ...process.env,
  GWP_OPS_COMPOSE_FILE: "compose.test.yaml",
  GWP_OPS_DB_SERVICE: "test-db",
};

function run(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("compose bundle (spec §9)", () => {
  // `.env` is the operator's customization point — this repo's own .env
  // re-points APP_PORT (8085), so a `docker compose config` spawned with
  // the inherited env renders operator values, not test values. A shell
  // env beats `.env` interpolation: pin APP_PORT in the child env so the
  // rendered assertions below stay hermetic on any machine.
  const COMPOSE_ENV = { ...process.env, APP_PORT: "18080" };

  function composeConfigJson(): {
    services: Record<
      string,
      {
        ports?: { target: number; published?: string | number }[];
        environment?: Record<string, string | null>;
      }
    >;
  } {
    const res = run(
      [
        "docker",
        "compose",
        "-f",
        "compose.yaml",
        "config",
        "--format",
        "json",
      ],
      COMPOSE_ENV,
    );
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout);
  }

  it("`docker compose config --quiet` validates compose.yaml", () => {
    const res = run(
      ["docker", "compose", "-f", "compose.yaml", "config", "--quiet"],
      COMPOSE_ENV,
    );
    expect(res.status, res.stderr).toBe(0);
  });

  it("publishes only the app port — db stays on the internal network", () => {
    const rendered = composeConfigJson();
    expect(rendered.services.db).toBeDefined();
    expect(rendered.services.db.ports ?? []).toHaveLength(0);

    const appPorts = rendered.services.app?.ports ?? [];
    expect(
      appPorts.some(
        (p) => p.target === 8080 && String(p.published) === "18080",
      ),
    ).toBe(true);
  });

  it("scopes container env per service — app never sees superuser/DDL creds", () => {
    // Assert on KEYS only (never values) so a failure diff cannot leak
    // .env secrets into test logs.
    const rendered = composeConfigJson();
    const envKeys = (service: string): string[] =>
      Object.keys(
        rendered.services[service]?.environment ?? {},
      ).sort();

    // The long-running attack surface carries ONLY its runtime allowlist
    // (config.ts's invariant: the app never holds the migrator credential)
    // — no POSTGRES_* superuser, MIGRATOR_/BACKUP_DATABASE_URL,
    // BOOTSTRAP_ADMIN_URL or GWP_*_PASSWORD may appear here.
    expect(envKeys("app")).toEqual(
      [
        "NODE_ENV",
        "PORT",
        "DATABASE_URL",
        "JWT_SECRET",
        "APP_KEY",
        "BOOTSTRAP_TOKEN",
        "DEMO_MODE",
        "APP_ORIGIN",
        "TRUST_PROXY",
        "ACCESS_TOKEN_TTL_SECONDS",
        "REFRESH_TOKEN_TTL_SECONDS",
      ].sort(),
    );

    // Postgres itself needs only its init vars — no app secrets.
    expect(envKeys("db")).toEqual(
      ["POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"].sort(),
    );

    // One-shot ops containers get their own subsets — the superuser URL
    // exists only in db-bootstrap; the DDL credential only in migrate.
    expect(envKeys("db-bootstrap")).toEqual(
      [
        "BOOTSTRAP_ADMIN_URL",
        "BOOTSTRAP_SCHEMA",
        "GWP_MIGRATOR_PASSWORD",
        "GWP_RUNTIME_PASSWORD",
        "GWP_MAINTENANCE_PASSWORD",
        "GWP_SET_ROLE_PASSWORDS",
      ].sort(),
    );
    expect(envKeys("migrate")).toEqual(
      ["DEMO_MODE", "MIGRATOR_DATABASE_URL", "NODE_ENV"].sort(),
    );
  });
});

describe("OpenAPI surface (spec §2)", () => {
  it("GET /api/v1/openapi.json serves the spec — no secrets inside", async () => {
    const f = await fixture();
    try {
      expect((await f.api().get("/health/live")).status).toBe(200);

      const res = await f.api().get("/api/v1/openapi.json");
      expect(res.status).toBe(200);
      const spec = res.body as {
        openapi: string;
        paths: Record<string, Record<string, unknown>>;
      };
      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.paths["/api/v1/setup"].post).toBeDefined();
      expect(spec.paths["/api/v1/auth/login"].post).toBeDefined();
      expect(spec.paths["/api/v1/auth/refresh"].post).toBeDefined();
      expect(spec.paths["/api/v1/auth/logout"].post).toBeDefined();
      expect(spec.paths["/api/v1/auth/me"].get).toBeDefined();
      expect(spec.paths["/health/live"].get).toBeDefined();
      expect(spec.paths["/health/ready"].get).toBeDefined();

      // The public contract must never carry credentials — not even
      // examples. Check both the served JSON and the source yaml.
      const forbidden = [
        FIXTURE_PASSWORD,
        testEnv.JWT_SECRET as string,
        testEnv.APP_KEY as string,
        testEnv.BOOTSTRAP_TOKEN as string,
        "postgres://",
      ];
      const served = JSON.stringify(spec);
      const source = readFileSync(
        path.join(repoRoot, "server", "openapi.yaml"),
        "utf8",
      );
      for (const secret of forbidden) {
        expect(served).not.toContain(secret);
        expect(source).not.toContain(secret);
      }
    } finally {
      await f.close();
    }
  });
});

describe("health semantics", () => {
  it("live 200 / ready 503 when the database is down", async () => {
    // A refused port fails the connection instantly — deterministic even
    // under suite load (no pool-teardown timing involved).
    const deadDb = createDb(
      "postgres://gwp_runtime:unused@127.0.0.1:1/gwp_test",
    );
    const app = createApp({
      db: deadDb,
      clock: () => new Date(),
      config: loadConfig(testEnv),
    });
    try {
      expect((await request(app).get("/health/live")).status).toBe(200);
      const res = await request(app).get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("DB_UNAVAILABLE");
    } finally {
      await deadDb.destroy().catch(() => {});
    }
  });

  it("live 200 / ready 503 MIGRATIONS_PENDING before migrations run", async () => {
    const f = await fixture({ migrated: false });
    try {
      expect((await f.api().get("/health/live")).status).toBe(200);
      const res = await f.api().get("/health/ready");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("MIGRATIONS_PENDING");
    } finally {
      await f.close();
    }
  });
});

describe("migrator idempotency", () => {
  it("a second migrate() run applies nothing and keeps tracking intact", async () => {
    const f = await fixture(); // already migrated once
    try {
      const schema = (
        await f.db.raw("select current_schema() as s")
      ).rows[0].s as string;
      const migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
        searchPath: schema,
      });
      try {
        await migrate(migratorDb); // re-run must be a no-op
        const status = await migrationStatus(migratorDb);
        expect(status.pending).toHaveLength(0);
        const rows = await migratorDb("schema_migration").count("* as c");
        expect(Number(rows[0].c)).toBe(MIGRATIONS.length);
        const states = await migratorDb("deployment_state").count("* as c");
        expect(Number(states[0].c)).toBe(1);
      } finally {
        await migratorDb.destroy();
      }
    } finally {
      await f.close();
    }
  });
});

describe("backup/restore smoke on the disposable test DB", () => {
  it(
    "pg_dump -Fc backup of a dedicated gwp_backup_src restores into gwp_restore_test",
    { timeout: 240_000 },
    async () => {
      // Whole-database pg_dump must NOT run against gwp_test: parallel
      // fixtures create/drop test_* schemas there and pg_dump fails when a
      // resolved schema disappears mid-dump (observed flake). A dedicated
      // database only this test ever touches makes the round-trip
      // deterministic. Destructive CREATE/DROP goes through the disposable
      // guard pair first (URL shape + live current_database()).
      assertDisposableDbUrl(TEST_MAINTENANCE_DATABASE_URL, {
        envVar: "TEST_MAINTENANCE_DATABASE_URL",
        dbName: "gwp_test",
        requireContainerHost: true,
      });
      const backupSrcUrl = TEST_MAINTENANCE_DATABASE_URL.replace(
        /\/gwp_test$/,
        "/gwp_backup_src",
      );
      const maintenance = createDb(TEST_MAINTENANCE_DATABASE_URL);
      try {
        await assertConnectedToDisposableDb(maintenance, "gwp_test");
        await maintenance.raw(
          "DROP DATABASE IF EXISTS gwp_backup_src WITH (FORCE)",
        );
        await maintenance.raw("CREATE DATABASE gwp_backup_src");
        try {
          // gwp_test is the container superuser and owns the fresh DB, so
          // migrate() runs all DDL directly — no role bootstrap needed on a
          // throwaway source.
          const src = createDb(backupSrcUrl);
          try {
            await migrate(src);
          } finally {
            await src.destroy();
          }

          const dumpPath = path.join(
            os.tmpdir(),
            `gwp-deploy-test-${randomUUID()}.dump`,
          );

          const backup = run(
            [
              "npx",
              "tsx",
              "scripts/ops/backup.ts",
              "--output",
              dumpPath,
            ],
            { ...OPS_ENV, BACKUP_DATABASE_URL: backupSrcUrl },
          );
          expect(backup.status, backup.stderr + backup.stdout).toBe(0);
          expect(backup.stdout).toContain(dumpPath);
          expect(statSync(dumpPath).size).toBeGreaterThan(0);

          const restore = run(
            [
              "npx",
              "tsx",
              "scripts/ops/restore-test.ts",
              "--backup",
              dumpPath,
              "--target",
              TEST_MAINTENANCE_DATABASE_URL,
            ],
            OPS_ENV,
          );
          expect(restore.status, restore.stderr + restore.stdout).toBe(0);
          expect(restore.stdout).toContain("gwp_restore_test");

          const restoredUrl = TEST_MAINTENANCE_DATABASE_URL.replace(
            /\/gwp_test$/,
            "/gwp_restore_test",
          );
          const restored = createDb(restoredUrl);
          try {
            const companies = await restored.raw(
              "select count(*) as c from company",
            );
            expect(Number(companies.rows[0].c)).toBeGreaterThanOrEqual(0);
            const applied = await restored.raw(
              "select count(*) as c from schema_migration",
            );
            expect(Number(applied.rows[0].c)).toBe(MIGRATIONS.length);
          } finally {
            await restored.destroy();
          }
        } finally {
          // Tidy: leave neither database behind on the disposable container
          // (both are re-dropped at the start of each run anyway).
          await maintenance.raw(
            "DROP DATABASE IF EXISTS gwp_restore_test WITH (FORCE)",
          );
          await maintenance.raw(
            "DROP DATABASE IF EXISTS gwp_backup_src WITH (FORCE)",
          );
        }
      } finally {
        await maintenance.destroy();
      }
    },
  );

  it("refuses a non-disposable --target without --i-understand", () => {
    const res = run(
      [
        "npx",
        "tsx",
        "scripts/ops/restore-test.ts",
        "--backup",
        "/tmp/irrelevant.dump",
        "--target",
        "postgres://ops:pw@db.internal.example.com:5432/postgres",
      ],
      OPS_ENV,
    );
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toMatch(
      /--i-understand|disposable|refus/i,
    );
  });
});
