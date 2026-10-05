import { z } from "zod";
import type { Knex } from "knex";
import type { Config } from "../../config.js";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { appendAudit } from "../audit/service.js";
import {
  assertActiveActor,
  loadActorRoles,
} from "../authorization/repository.js";
import {
  decryptSecret,
  encryptSecret,
  SECRET_DECRYPT_FAILED,
  SECRET_KEY_UNKNOWN_VERSION,
} from "../../security/secrets.js";
import { validateAiDestination } from "../../security/ai-destination.js";
import { AI_BAD_RESPONSE, complete } from "./adapter.js";
import {
  AI_MAX_OUTPUT_TOKENS,
  AI_TIMEOUT_MAX_SECONDS,
  type AiSettingsInput,
} from "./schema.js";

/**
 * BYOK AI settings (task 3.1, spec §7.1/§9): one active AI configuration per
 * company, stored as the `setting` row keyed (company_id, 'ai'). The apiKey
 * is AES-256-GCM encrypted under APP_KEY before it ever touches the row —
 * the database, backups and dumps hold only the versioned envelope.
 *
 * Trust contract:
 * - GET and all mutations are owner/admin ONLY (spec §4 grants the manager
 *   and member rows nothing here — even the public shape stays privileged).
 *   Roles and actor status are re-read inside the transaction under the
 *   company lock, same as every privileged mutation (§4).
 * - The public document NEVER carries the key, the envelope, or any crypto
 *   material — only `configured`, the endpoint/model and the bounds.
 * - baseUrl must pass the operator allowlist (AI_ALLOWED_HOSTS) — an admin
 *   cannot aim the app's outbound AI client at an arbitrary host.
 * - Audit metadata is allowlisted scalars only: key name, key_version,
 *   model, status — never values or secrets (§9).
 */

export const AI_KEY_DECRYPT_FAILED = "AI_KEY_DECRYPT_FAILED";
const SETTING_KEY = "ai";

const envelopeSchema = z
  .object({
    ciphertext: z.string(),
    iv: z.string(),
    tag: z.string(),
    keyVersion: z.string(),
  })
  .strict();

const storedAiSchema = z
  .object({
    v: z.literal(1),
    enabled: z.boolean(),
    baseUrl: z.string(),
    model: z.string(),
    timeoutSeconds: z.number().int(),
    maxOutputTokens: z.number().int(),
    keyEnvelope: envelopeSchema.nullable(),
  })
  .strict();

type StoredAiSettings = z.infer<typeof storedAiSchema>;

/** What GET returns — safe metadata only, never key material. */
export interface PublicAiSettings {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  timeoutSeconds: number;
  maxOutputTokens: number;
  keyVersion: string | null;
  updatedAt: string | null;
}

/** Server-internal decrypted config — adapter input, never serialized. */
export interface AiRuntimeConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
  keyVersion: string;
}

const PUBLIC_DEFAULTS: PublicAiSettings = {
  configured: false,
  enabled: false,
  baseUrl: null,
  model: null,
  timeoutSeconds: AI_TIMEOUT_MAX_SECONDS,
  maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
  keyVersion: null,
  updatedAt: null,
};

interface SettingRow {
  value: unknown;
  updated_at: Date | string;
}

export function createAiSettingsService({
  db,
  clock,
  config,
}: {
  db: Knex;
  clock: Clock;
  config: Config;
}) {
  async function readRow(companyId: string): Promise<SettingRow | undefined> {
    return (await db("setting")
      .where({ company_id: companyId, key: SETTING_KEY })
      .select("value", "updated_at")
      .first()) as SettingRow | undefined;
  }

  function toPublic(row: SettingRow | undefined): PublicAiSettings {
    const parsed = storedAiSchema.safeParse(row?.value);
    if (!row || !parsed.success) return { ...PUBLIC_DEFAULTS };
    const s = parsed.data;
    return {
      configured: s.keyEnvelope !== null,
      enabled: s.enabled,
      baseUrl: s.baseUrl,
      model: s.model,
      timeoutSeconds: s.timeoutSeconds,
      maxOutputTokens: s.maxOutputTokens,
      keyVersion: s.keyEnvelope?.keyVersion ?? null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /**
   * Owner/admin gate (spec §4): roles + actor status re-read from the DB
   * inside a transaction holding the company lock — the check serializes
   * against the same lock role changes and deactivation take, so an
   * in-flight request from a just-demoted admin still 403s.
   */
  async function assertAiAdmin(tx: Knex.Transaction, actor: ActorContext) {
    await lockCompany(tx, actor.companyId);
    const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
    if (!roles.includes("owner") && !roles.includes("admin")) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Chỉ owner hoặc admin được cấu hình AI",
      );
    }
    await assertActiveActor(tx, actor.companyId, actor.userId);
  }

  /** Public shape — privileged read (member/manager 403 per spec §4). */
  async function getAiSettings(
    actor: ActorContext,
  ): Promise<PublicAiSettings> {
    return db.transaction(async (tx) => {
      await assertAiAdmin(tx, actor);
      return toPublic(await readRow(actor.companyId));
    });
  }

  /**
   * Availability signal for ANY signed-in user (spec §7.1: "Chưa cấu
   * hình/AI tắt: UI báo rõ" — before consent, not after a failed run).
   * Exactly two booleans: no endpoint, model, key version or timestamps —
   * the settings document itself stays owner/admin only. `enabled` means
   * "usable": a stored enabled flag without a key still reads false.
   */
  async function getAiStatus(
    actor: ActorContext,
  ): Promise<{ configured: boolean; enabled: boolean }> {
    const pub = toPublic(await readRow(actor.companyId));
    return { configured: pub.configured, enabled: pub.configured && pub.enabled };
  }

  /**
   * Full replace of the AI configuration. The destination is validated
   * against the operator allowlist BEFORE anything is stored — a denied
   * baseUrl never persists. apiKey absent → the stored envelope survives;
   * apiKey present → re-encrypted under the ring's active version.
   */
  async function saveAiSettings(
    actor: ActorContext,
    input: AiSettingsInput,
  ): Promise<PublicAiSettings> {
    const dest = validateAiDestination(
      input.baseUrl,
      config.aiAllowedHosts,
      config.aiAllowHttp,
    );
    const baseUrl = dest.toString().replace(/\/+$/, "");
    return db.transaction(async (tx) => {
      await assertAiAdmin(tx, actor);
      const prior = storedAiSchema.safeParse(
        (await readRow(actor.companyId))?.value,
      );
      const keyEnvelope =
        input.apiKey !== undefined
          ? encryptSecret(input.apiKey, config.appKeyRing, actor.companyId)
          : prior.success
            ? prior.data.keyEnvelope
            : null;
      const stored: StoredAiSettings = {
        v: 1,
        enabled: input.enabled,
        baseUrl,
        model: input.model,
        timeoutSeconds: input.timeoutSeconds,
        maxOutputTokens: input.maxOutputTokens,
        keyEnvelope,
      };
      await tx("setting")
        .insert({
          company_id: actor.companyId,
          key: SETTING_KEY,
          value: stored,
          updated_by: actor.userId,
          updated_at: clock(),
        })
        .onConflict(["company_id", "key"])
        .merge(["value", "updated_by", "updated_at"]);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "settings.ai.update",
        outcome: "success",
        requestId: actor.requestId,
        metadata: {
          key: SETTING_KEY,
          key_version: keyEnvelope?.keyVersion ?? null,
          model: stored.model,
          status: stored.enabled ? "enabled" : "disabled",
        },
      });
      return toPublic({ value: stored, updated_at: clock() });
    });
  }

  /**
   * Explicit key removal — a separate command, never a side effect of an
   * omitted field. Other settings (endpoint/model/enabled) are kept so the
   * operator sees the last working configuration minus its credential.
   */
  async function clearAiKey(actor: ActorContext): Promise<PublicAiSettings> {
    return db.transaction(async (tx) => {
      await assertAiAdmin(tx, actor);
      const row = await readRow(actor.companyId);
      const prior = storedAiSchema.safeParse(row?.value);
      if (!row || !prior.success) return { ...PUBLIC_DEFAULTS };
      const stored: StoredAiSettings = { ...prior.data, keyEnvelope: null };
      await tx("setting")
        .insert({
          company_id: actor.companyId,
          key: SETTING_KEY,
          value: stored,
          updated_by: actor.userId,
          updated_at: clock(),
        })
        .onConflict(["company_id", "key"])
        .merge(["value", "updated_by", "updated_at"]);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "settings.ai.key.clear",
        outcome: "success",
        requestId: actor.requestId,
        metadata: { key: SETTING_KEY },
      });
      return toPublic({ value: stored, updated_at: clock() });
    });
  }

  /**
   * Server-internal decrypt for the adapter (task 3.2+). Returns null when
   * unconfigured or unkeyed — callers map that to AI_NOT_CONFIGURED. Any
   * decrypt failure is remapped to the stable AI_KEY_DECRYPT_FAILED code;
   * the crypto detail never crosses the module boundary.
   */
  async function loadAiConfig(
    companyId: string,
  ): Promise<AiRuntimeConfig | null> {
    const parsed = storedAiSchema.safeParse((await readRow(companyId))?.value);
    if (!parsed.success) return null;
    const s = parsed.data;
    const envelope = s.keyEnvelope;
    if (envelope === null) return null;
    let apiKey: string;
    try {
      apiKey = decryptSecret(envelope, config.appKeyRing, companyId);
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === SECRET_DECRYPT_FAILED ||
          err.code === SECRET_KEY_UNKNOWN_VERSION)
      ) {
        throw new AppError(
          500,
          AI_KEY_DECRYPT_FAILED,
          "Không giải mã được key AI đã lưu — hãy nhập lại key",
        );
      }
      throw err;
    }
    return {
      enabled: s.enabled,
      baseUrl: s.baseUrl,
      apiKey,
      model: s.model,
      timeoutSeconds: s.timeoutSeconds,
      maxOutputTokens: s.maxOutputTokens,
      keyVersion: envelope.keyVersion,
    };
  }

  /**
   * Connection probe (task 3.2): synthetic prompt only — never customer
   * content (spec §7.1). Verifies auth + model + completion, and detects
   * streaming support by trying SSE first then a bounded non-stream call.
   * Owner/admin gated in a short transaction; the network call itself runs
   * OUTSIDE any DB transaction (spec: no AI HTTP inside a tx).
   */
  async function testConnection(actor: ActorContext): Promise<{
    ok: true;
    streaming: boolean;
    model: string;
    latencyMs: number;
  }> {
    await db.transaction(async (tx) => {
      await assertAiAdmin(tx, actor);
    });
    const cfg = await loadAiConfig(actor.companyId);
    if (!cfg) {
      throw new AppError(
        503,
        "AI_NOT_CONFIGURED",
        "Chưa cấu hình endpoint/key AI — lưu settings trước",
      );
    }
    const probe = (stream: boolean) =>
      complete({
        config: cfg,
        messages: [{ role: "user", content: "Reply with the word OK." }],
        maxOutputTokens: 16,
        stream,
      });
    const started = Date.now();
    try {
      const r = await probe(true);
      return {
        ok: true,
        streaming: r.streamed,
        model: cfg.model,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      // A gateway that cannot stream may reject the request shape; retry
      // once without stream to confirm the endpoint works non-streamed.
      if (err instanceof AppError && err.code === AI_BAD_RESPONSE) {
        await probe(false);
        return {
          ok: true,
          streaming: false,
          model: cfg.model,
          latencyMs: Date.now() - started,
        };
      }
      throw err;
    }
  }

  return {
    getAiSettings,
    getAiStatus,
    saveAiSettings,
    clearAiKey,
    loadAiConfig,
    testConnection,
  };
}

export type AiSettingsService = ReturnType<typeof createAiSettingsService>;
