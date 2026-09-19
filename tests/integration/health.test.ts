import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../server/src/app.js";
import { createDb } from "../../server/src/db/connection.js";
import { loadConfig } from "../../server/src/config.js";
import {
  fixture,
  testEnv,
  TEST_DATABASE_URL,
  TEST_MIGRATOR_DATABASE_URL,
  type Fixture,
} from "../helpers/fixture.js";

const clock = () => new Date("2026-09-20T00:00:00Z");
const config = loadConfig(testEnv);

describe("health endpoints", () => {
  it("GET /health/live returns 200 without touching the DB", async () => {
    // A destroyed pool proves liveness never reaches for the database.
    const deadDb = createDb(TEST_DATABASE_URL);
    await deadDb.destroy();
    const app = createApp({ db: deadDb, clock, config });
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("unknown /api/v1 route returns 404 NOT_FOUND envelope with request_id", async () => {
    const db = createDb(TEST_DATABASE_URL);
    const app = createApp({ db, clock, config });
    const res = await request(app).get("/api/v1/missing");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "NOT_FOUND",
      request_id: expect.any(String),
    });
    expect(res.headers["x-request-id"]).toBe(res.body.request_id);
    await db.destroy();
  });
});

describe("fixture-isolated readiness & body limit", () => {
  it("GET /health/ready is 200 when migrations are applied", async () => {
    const f: Fixture = await fixture();
    try {
      const res = await f.api().get("/health/ready");
      expect(res.status).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("GET /health/ready returns 503 DB_UNAVAILABLE when the DB is down", async () => {
    const deadDb = createDb(TEST_DATABASE_URL);
    const app = createApp({ db: deadDb, clock, config });
    await deadDb.destroy();
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: "DB_UNAVAILABLE",
      request_id: expect.any(String),
    });
  });

  it("rejects JSON bodies larger than 2 MiB with 413", async () => {
    const f = await fixture();
    try {
      const payload = `{"data":"${"x".repeat(2 * 1024 * 1024)}"}`;
      const res = await f
        .api()
        .post("/api/v1/anything")
        .set("Content-Type", "application/json")
        .send(payload);
      expect(res.status).toBe(413);
      expect(res.body.code).toEqual(expect.any(String));
      expect(res.body.request_id).toEqual(expect.any(String));
    } finally {
      await f.close();
    }
  });

  it("isolates each fixture in its own schema", async () => {
    const a = await fixture();
    const b = await fixture();
    try {
      const schemaA = (
        await a.db.raw("select current_schema() as s")
      ).rows[0].s as string;
      const schemaB = (
        await b.db.raw("select current_schema() as s")
      ).rows[0].s as string;
      expect(schemaA).not.toBe(schemaB);
      expect(schemaA).toMatch(/^test_[0-9a-f]{32}$/);

      // f.db is the runtime role — it has no DDL. The probe table goes through
      // the migrator credential into fixture a's schema only.
      const migratorDb = createDb(TEST_MIGRATOR_DATABASE_URL, {
        searchPath: schemaA,
      });
      try {
        await migratorDb.schema.createTable("probe", (t) => {
          t.increments("id");
        });
        expect(await migratorDb.schema.hasTable("probe")).toBe(true);
      } finally {
        await migratorDb.destroy();
      }
      expect(await b.db.schema.hasTable("probe")).toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("exposes the Fixture contract surface (ids, actor, api, close)", async () => {
    const f = await fixture();
    try {
      expect(f.ids.company).toEqual(expect.any(String));
      expect(f.ids.otherCompany).toEqual(expect.any(String));
      expect(f.ids.owner).toEqual(expect.any(String));
      const actor = f.actor("member");
      expect(actor.companyId).toBe(f.ids.company);
      expect(actor.userId).toBe(f.ids.member);
      const res = await f.api("owner").get("/health/live");
      expect(res.status).toBe(200);
    } finally {
      await f.close();
    }
  });
});
