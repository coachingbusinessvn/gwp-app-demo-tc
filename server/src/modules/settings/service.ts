import { z } from "zod";
import type { Knex } from "knex";
import type { ActorContext, Clock } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { lockCompany } from "../../shared/company-lock.js";
import { appendAudit } from "../audit/service.js";
import {
  assertActiveActor,
  loadActorRoles,
} from "../authorization/repository.js";

/**
 * Company settings (task 1.5, spec §4/§9): the branding record is the only
 * setting Phase 1 exposes. It lives in the `setting` table keyed
 * (company_id, 'branding') — value is a jsonb document validated by the
 * schema below on every write.
 *
 * Branding safety contract (controller ruling):
 * - The schema is the entire boundary: displayName is plain text 1-120
 *   chars and accentColor must match /^#[0-9a-fA-F]{6}$/. There is NO
 *   field that could carry a URL, a CSS payload or an on* handler, so a
 *   stored document can never become markup or code — the client renders
 *   displayName via textContent and applies accentColor as a validated
 *   CSS custom-property value only.
 * - GET is open to any authenticated member: branding is what
 *   personalizes the shell for everyone, so it is not a privileged read.
 * - PATCH is owner/admin only, serialized on the company lock and audited
 *   with the setting KEY NAME only — the allowlisted `key` metadata field
 *   never carries the stored value (spec §9: no config values in audit).
 */
export const brandingSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();
export type Branding = z.infer<typeof brandingSchema>;

const BRANDING_KEY = "branding";

/** Shipped defaults — the unpersonalized shell matches index.html. */
export const DEFAULT_BRANDING: Branding = {
  displayName: "GoWise Partners",
  accentColor: "#C9A668", // --gp-gold-400
};

/**
 * Retention floors (task 4.5, spec §9): shipped defaults are the spec
 * minimums; the owner may RAISE them, never lower — the schema enforces
 * the floor so a lower value is a plain 400, not a silent clamp. The
 * retention job applies max(default, configured) per company.
 * logDays covers operational/container logs rotated by the logging
 * driver — it is stored here so one document is the retention contract.
 */
export const RETENTION_FLOORS = {
  auditDays: 365,
  aiRunDays: 90,
  logDays: 30,
  receiptDays: 7,
} as const;

export const retentionSchema = z
  .object({
    auditDays: z.number().int().min(RETENTION_FLOORS.auditDays),
    aiRunDays: z.number().int().min(RETENTION_FLOORS.aiRunDays),
    logDays: z.number().int().min(RETENTION_FLOORS.logDays),
    receiptDays: z.number().int().min(RETENTION_FLOORS.receiptDays),
  })
  .strict();
export type Retention = z.infer<typeof retentionSchema>;

const RETENTION_KEY = "retention";

export const DEFAULT_RETENTION: Retention = { ...RETENTION_FLOORS };

interface SettingRow {
  value: unknown;
}

export function createSettingsService({ db, clock }: { db: Knex; clock: Clock }) {
  /**
   * Any authenticated member may read branding (it personalizes their
   * shell). authenticate() has already proven the caller is an ACTIVE user
   * of this company. A missing or malformed stored document falls back to
   * the shipped defaults — reads never fail on legacy/bad data.
   */
  async function getBranding(actor: ActorContext): Promise<Branding> {
    const row = (await db("setting")
      .where({ company_id: actor.companyId, key: BRANDING_KEY })
      .select("value")
      .first()) as SettingRow | undefined;
    const parsed = brandingSchema.safeParse(row?.value);
    return parsed.success ? parsed.data : { ...DEFAULT_BRANDING };
  }

  /**
   * PATCH is a full replace of the branding document (the strict schema
   * requires both fields). Owner/admin only — roles re-read inside the
   * transaction, never from the JWT (spec §4). The actor's status is
   * re-read under the same lock: role rows survive deactivation, so an
   * in-flight PATCH from a just-deactivated admin must still 403.
   */
  async function updateBranding(
    actor: ActorContext,
    input: Branding,
  ): Promise<Branding> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
      if (!roles.includes("owner") && !roles.includes("admin")) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ owner hoặc admin được đổi nhận diện",
        );
      }
      await assertActiveActor(tx, actor.companyId, actor.userId);
      await tx("setting")
        .insert({
          company_id: actor.companyId,
          key: BRANDING_KEY,
          value: input,
          updated_by: actor.userId,
          updated_at: clock(),
        })
        .onConflict(["company_id", "key"])
        .merge(["value", "updated_by", "updated_at"]);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "settings.branding.update",
        outcome: "success",
        requestId: actor.requestId,
        // The audit allowlist admits the setting's key NAME only — the
        // stored displayName/accentColor values are never recorded (§9).
        metadata: { key: BRANDING_KEY },
      });
      return input;
    });
  }

  /**
   * Owner/admin may read the retention floors (they are operational
   * policy, not secrets). Missing/malformed rows fall back to defaults.
   */
  async function getRetention(actor: ActorContext): Promise<Retention> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
      if (!roles.includes("owner") && !roles.includes("admin")) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ owner hoặc admin được xem retention",
        );
      }
      await assertActiveActor(tx, actor.companyId, actor.userId);
      const row = (await tx("setting")
        .where({ company_id: actor.companyId, key: RETENTION_KEY })
        .select("value")
        .first()) as SettingRow | undefined;
      const parsed = retentionSchema.safeParse(row?.value);
      return parsed.success ? parsed.data : { ...DEFAULT_RETENTION };
    });
  }

  /**
   * Owner-only write (spec §9: "owner được tăng thời gian giữ") — admin
   * is deliberately excluded: retention is the data-retention contract,
   * not an operational toggle. The schema's min() bounds make a decrease
   * impossible; a stored document only ever raises the floor.
   */
  async function updateRetention(
    actor: ActorContext,
    input: Retention,
  ): Promise<Retention> {
    return db.transaction(async (tx) => {
      await lockCompany(tx, actor.companyId);
      const roles = await loadActorRoles(tx, actor.companyId, actor.userId);
      if (!roles.includes("owner")) {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Chỉ owner được đổi retention",
        );
      }
      await assertActiveActor(tx, actor.companyId, actor.userId);
      await tx("setting")
        .insert({
          company_id: actor.companyId,
          key: RETENTION_KEY,
          value: input,
          updated_by: actor.userId,
          updated_at: clock(),
        })
        .onConflict(["company_id", "key"])
        .merge(["value", "updated_by", "updated_at"]);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.userId,
        action: "settings.retention.update",
        outcome: "success",
        requestId: actor.requestId,
        metadata: { key: RETENTION_KEY },
      });
      return input;
    });
  }

  return { getBranding, updateBranding, getRetention, updateRetention };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
