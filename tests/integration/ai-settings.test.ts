import { describe, expect, it } from "vitest";
import { loadConfig } from "../../server/src/config.js";
import {
  createAiSettingsService,
  AI_KEY_DECRYPT_FAILED,
} from "../../server/src/modules/ai/settings.js";
import { AppError } from "../../server/src/shared/errors.js";
import { fixture, testEnv, type Fixture } from "../helpers/fixture.js";

/**
 * Task 3.1 — BYOK AI settings (spec §7.1).
 *
 * Contract under test:
 * - GET/PUT /api/v1/settings/ai and DELETE /api/v1/settings/ai/key are
 *   owner/admin only — manager/member/outsider 403, anonymous 401.
 * - The stored apiKey is AES-256-GCM encrypted under APP_KEY and NEVER
 *   appears in any API response, the public settings document, or the
 *   audit trail (metadata is key-name/key-version/model only).
 * - baseUrl must match the operator allowlist (AI_ALLOWED_HOSTS) exactly
 *   on host+port; userinfo is rejected; http:// requires the explicit
 *   AI_ALLOW_HTTP opt-in; private IPs are fine when allowlisted.
 * - Omitting apiKey preserves the stored key; DELETE clears it.
 * - A mismatched APP_KEY ring produces a controlled AppError, not a
 *   crash or a leaked detail.
 */

const VALID_PUT = {
  enabled: true,
  baseUrl: "https://llm.internal:8443/v1",
  apiKey: "local-secret",
  model: "pilot",
};

describe("BYOK AI settings (task 3.1)", () => {
  it("defaults before first save; member/manager/outsider 403; anonymous 401", async () => {
    const f = await fixture({ seeded: true });
    try {
      const r = await f.api("owner").get("/api/v1/settings/ai");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ configured: false, enabled: false });
      expect(JSON.stringify(r.body)).not.toContain("ciphertext");

      for (const p of ["member", "manager", "outsider"] as const) {
        expect((await f.api(p).get("/api/v1/settings/ai")).status).toBe(403);
        expect(
          (await f.api(p).put("/api/v1/settings/ai").send(VALID_PUT)).status,
        ).toBe(403);
      }
      expect((await f.api().get("/api/v1/settings/ai")).status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("owner and admin can save; the key never appears in responses or the DB value as plaintext", async () => {
    const f = await fixture({ seeded: true });
    try {
      const r = await f.api("admin").put("/api/v1/settings/ai").send(VALID_PUT);
      expect(r.status).toBe(200);
      expect(r.body.configured).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain("local-secret");
      for (const k of ["apiKey", "ciphertext", "iv", "tag"]) {
        expect(r.body).not.toHaveProperty(k);
      }

      const g = await f.api("owner").get("/api/v1/settings/ai");
      expect(g.status).toBe(200);
      expect(g.body).toMatchObject({
        configured: true,
        enabled: true,
        baseUrl: "https://llm.internal:8443/v1",
        model: "pilot",
      });
      expect(JSON.stringify(g.body)).not.toContain("local-secret");

      // The stored setting row carries an envelope, never the plaintext key.
      const row = await f
        .db("setting")
        .where({ company_id: f.ids.company, key: "ai" })
        .first();
      expect(row).toBeTruthy();
      const stored = JSON.stringify(row.value);
      expect(stored).not.toContain("local-secret");
      expect(row.value.keyEnvelope).toMatchObject({ keyVersion: "v1" });
    } finally {
      await f.close();
    }
  });

  it("destination validation: external/userinfo/http denied; allowlisted private IP accepted", async () => {
    const f = await fixture({ seeded: true });
    try {
      const denied = async (baseUrl: string, code?: string) => {
        const r = await f
          .api("admin")
          .put("/api/v1/settings/ai")
          .send({ ...VALID_PUT, baseUrl });
        expect(r.status).toBe(400);
        if (code) expect(r.body.code).toBe(code);
      };

      await denied("https://api.openai.com/v1"); // not allowlisted
      await denied("https://llm.internal:8444/v1"); // wrong port
      await denied("https://user:pw@llm.internal:8443/v1"); // userinfo
      await denied("http://llm.internal:8443/v1", "AI_HTTP_NOT_ALLOWED");
      await denied("ftp://llm.internal:8443/v1"); // not http(s)
      await denied("not-a-url");

      // Private IP is valid when the operator explicitly allowlists it.
      const ok = await f
        .api("admin")
        .put("/api/v1/settings/ai")
        .send({ ...VALID_PUT, baseUrl: "https://10.20.30.40:11434/v1" });
      expect(ok.status).toBe(200);
    } finally {
      await f.close();
    }
  });

  it("omitted apiKey preserves the stored key; DELETE clears it explicitly", async () => {
    const f = await fixture({ seeded: true });
    try {
      await f.api("admin").put("/api/v1/settings/ai").send(VALID_PUT);

      // Re-save without apiKey — key survives, other fields update.
      const again = await f
        .api("admin")
        .put("/api/v1/settings/ai")
        .send({ ...VALID_PUT, apiKey: undefined, model: "pilot-2" });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ configured: true, model: "pilot-2" });

      const del = await f.api("admin").delete("/api/v1/settings/ai/key");
      expect(del.status).toBe(200);
      expect(del.body.configured).toBe(false);

      // Saving without a key stays unconfigured — no invented credential.
      const empty = await f
        .api("admin")
        .put("/api/v1/settings/ai")
        .send({ ...VALID_PUT, apiKey: undefined });
      expect(empty.status).toBe(200);
      expect(empty.body.configured).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("strict schema: extra keys, null apiKey and out-of-bound limits are 400", async () => {
    const f = await fixture({ seeded: true });
    try {
      const bad = async (patch: Record<string, unknown>) => {
        const r = await f
          .api("admin")
          .put("/api/v1/settings/ai")
          .send({ ...VALID_PUT, ...patch });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe("INVALID_INPUT");
      };
      await bad({ rogue: true });
      await bad({ apiKey: null });
      await bad({ enabled: "yes" });
      await bad({ timeoutSeconds: 181 }); // spec §7.3 bound: <=180s
      await bad({ timeoutSeconds: 0 });
      await bad({ maxOutputTokens: 8193 }); // spec §7.3 bound: <=8192
      await bad({ model: "" });
    } finally {
      await f.close();
    }
  });

  it("audits the config change by key name/version only — never the secret", async () => {
    const f = await fixture({ seeded: true });
    try {
      await f.api("admin").put("/api/v1/settings/ai").send(VALID_PUT);
      const rows = await f
        .db("audit_event")
        .where({ company_id: f.ids.company, action: "settings.ai.update" });
      expect(rows.length).toBe(1);
      const meta = rows[0].safe_metadata;
      expect(meta.key).toBe("ai");
      expect(meta.model).toBe("pilot");
      expect(JSON.stringify(meta)).not.toContain("local-secret");
      expect(meta).not.toHaveProperty("apiKey");
      expect(meta).not.toHaveProperty("ciphertext");
    } finally {
      await f.close();
    }
  });

  it("PUT is rate-limited per client IP", async () => {
    const f = await fixture({ seeded: true });
    try {
      let last = 0;
      for (let i = 0; i < 11; i++) {
        const r = await f.api("admin").put("/api/v1/settings/ai").send(VALID_PUT);
        last = r.status;
      }
      expect(last).toBe(429);
    } finally {
      await f.close();
    }
  });

  it("a mismatched APP_KEY ring fails decryption with a controlled error", async () => {
    const f = await fixture({ seeded: true });
    try {
      await f.api("admin").put("/api/v1/settings/ai").send(VALID_PUT);

      // Same DB, different master key — the envelope's AAD/tag must reject it.
      const wrongConfig = loadConfig({
        ...testEnv,
        APP_KEY: "a-different-master-key-0123456789abcdef",
      });
      const wrongRingService = createAiSettingsService({
        db: f.db,
        clock: () => new Date(),
        config: wrongConfig,
      });
      await expect(
        wrongRingService.loadAiConfig(f.ids.company),
      ).rejects.toMatchObject({ code: AI_KEY_DECRYPT_FAILED });

      // The right ring decrypts — server-internal path only.
      const right = createAiSettingsService({
        db: f.db,
        clock: () => new Date(),
        config: loadConfig(testEnv),
      });
      const loaded = await right.loadAiConfig(f.ids.company);
      expect(loaded?.apiKey).toBe("local-secret");
      expect(loaded?.model).toBe("pilot");
    } finally {
      await f.close();
    }
  });

  it("decrypting with a ring that lacks the envelope's version is a controlled error", async () => {
    const f = await fixture({ seeded: true });
    try {
      await f.api("admin").put("/api/v1/settings/ai").send(VALID_PUT);
      // A ring that only knows v2 cannot open a v1 envelope.
      const rotatedConfig = loadConfig({
        ...testEnv,
        APP_KEY: "v2=some-new-master-key-0123456789abcdef",
      });
      const rotated = createAiSettingsService({
        db: f.db,
        clock: () => new Date(),
        config: rotatedConfig,
      });
      await expect(
        rotated.loadAiConfig(f.ids.company),
      ).rejects.toMatchObject({ code: AI_KEY_DECRYPT_FAILED });
      await expect(rotated.loadAiConfig(f.ids.company)).rejects.toBeInstanceOf(
        AppError,
      );
    } finally {
      await f.close();
    }
  });
});
