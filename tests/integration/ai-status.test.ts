import { describe, expect, it } from "vitest";
import { fixture, PERSONAS } from "../helpers/fixture.js";

/**
 * GET /api/v1/ai/status — the read-only availability signal every signed-in
 * user needs BEFORE consenting to an AI run (spec §7.1: "Chưa cấu hình/AI
 * tắt: UI báo rõ"). It answers exactly {configured, enabled}: no endpoint,
 * no model, no key version, no key material — the full settings document
 * stays owner/admin only (GET /settings/ai).
 */
const VALID_PUT = {
  enabled: true,
  baseUrl: "https://llm.internal:8443/v1",
  apiKey: "local-secret",
  model: "pilot",
};

describe("GET /api/v1/ai/status", () => {
  it("reports not-configured to every persona and 401 to anonymous", async () => {
    const f = await fixture({ seeded: true });
    try {
      for (const p of PERSONAS) {
        const r = await f.api(p).get("/api/v1/ai/status");
        expect(r.status, p).toBe(200);
        expect(r.body).toEqual({ configured: false, enabled: false });
      }
      expect((await f.api().get("/api/v1/ai/status")).status).toBe(401);

      // The contract documents this status route alongside the lifecycle
      // routes added with it (canvas rename, session list).
      const spec = (await f.api().get("/api/v1/openapi.json")).body as {
        paths: Record<string, Record<string, unknown>>;
      };
      expect(spec.paths["/api/v1/ai/status"].get).toBeDefined();
      expect(spec.paths["/api/v1/canvases/{id}"].patch).toBeDefined();
      expect(spec.paths["/api/v1/coaching-sessions"].get).toBeDefined();
    } finally {
      await f.close();
    }
  });

  it("tracks configure / disable / key clear without leaking settings detail", async () => {
    const f = await fixture({ seeded: true });
    try {
      expect(
        (await f.api("owner").put("/api/v1/settings/ai").send(VALID_PUT)).status,
      ).toBe(200);
      let r = await f.api("member").get("/api/v1/ai/status");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ configured: true, enabled: true });
      const raw = JSON.stringify(r.body);
      for (const leak of ["llm.internal", "pilot", "local-secret", "keyVersion", "baseUrl"]) {
        expect(raw).not.toContain(leak);
      }

      const { apiKey: _omit, ...withoutKey } = VALID_PUT;
      void _omit;
      expect(
        (
          await f
            .api("admin")
            .put("/api/v1/settings/ai")
            .send({ ...withoutKey, enabled: false })
        ).status,
      ).toBe(200);
      r = await f.api("manager").get("/api/v1/ai/status");
      expect(r.body).toEqual({ configured: true, enabled: false });

      expect((await f.api("owner").delete("/api/v1/settings/ai/key")).status).toBe(200);
      r = await f.api("member").get("/api/v1/ai/status");
      expect(r.body).toEqual({ configured: false, enabled: false });
    } finally {
      await f.close();
    }
  });
});
