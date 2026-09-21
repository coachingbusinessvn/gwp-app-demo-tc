import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";
import { createDb } from "../../server/src/db/connection.js";
import {
  addRingEntry,
  decryptSecret,
  encryptSecret,
  parseKeyRing,
  type KeyRingEntry,
  type SecretEnvelope,
} from "../../server/src/security/secrets.js";

/**
 * rotate-key (task 4.5, spec §9) — re-encrypt every stored BYOK envelope
 * under a NEW APP_KEY version, in ONE transaction, under the maintenance
 * credential (SELECT + column-scoped UPDATE on `setting` — never the
 * app runtime account, never the superuser).
 *
 * Usage:
 *   MAINTENANCE_DATABASE_URL=postgres://gwp_maintenance:…/gwp \
 *   APP_KEY='v1=<old material>' \
 *   node dist/scripts/ops/rotate-key.js --to v2 --material-file /run/secrets/app_key_v2
 *
 * Safety contract:
 * - The NEW material comes from a file/protected mount — never argv
 *   (ps history) and never stdout.
 * - Two-phase inside one transaction: EVERY envelope is decrypted under
 *   the current ring first; only when all decrypt does the rewrite run.
 *   A single corrupt/foreign row aborts the whole switch — no partial
 *   rotation is ever committed.
 * - After the rewrite each row is decrypted AGAIN under the merged ring
 *   before commit — a write that cannot be read back aborts the tx.
 * - Post-restart the operator keeps the old version in APP_KEY until the
 *   encrypted-backup window expires (runbook): an envelope restored from
 *   a pre-rotation backup still opens under the retained version.
 * - Envelope scan is `value ? 'keyEnvelope'` — any setting key that ever
 *   carries an envelope is rotated, not just today's 'ai' key.
 */

export interface RotateOptions {
  /** Qualify `setting` explicitly — test schemas isolate per fixture. */
  schema?: string;
  /** The CURRENT parsed ring (every version still needed to decrypt). */
  ring: KeyRingEntry[];
  toVersion: string;
  toMaterial: string;
}

interface EnvelopeRow {
  company_id: string;
  key: string;
  value: { keyEnvelope?: SecretEnvelope | null } & Record<string, unknown>;
}

export async function rotateEnvelopes(
  db: Knex,
  opts: RotateOptions,
): Promise<{ rotated: number }> {
  const newRing = addRingEntry(opts.ring, opts.toVersion, opts.toMaterial);
  const table = opts.schema ? `${opts.schema}.setting` : "setting";

  return db.transaction(async (tx) => {
    const rows = (await tx(table)
      // jsonb_exists() not the `?` operator — knex treats '?' as a binding.
      .whereRaw("jsonb_exists(value::jsonb, 'keyEnvelope')")
      .whereRaw("value::jsonb -> 'keyEnvelope' IS NOT NULL")
      .select("company_id", "key", "value")) as EnvelopeRow[];

    // Phase 1 — validate EVERY row opens under the current ring before a
    // single write happens; any failure throws and aborts the tx.
    const plains = rows.map((row) =>
      decryptSecret(row.value.keyEnvelope!, opts.ring, row.company_id),
    );

    // Phase 2 — rewrite under the new active version, then prove each
    // fresh envelope opens under the merged ring inside the same tx.
    for (const [i, row] of rows.entries()) {
      const reencrypted = encryptSecret(plains[i]!, newRing, row.company_id);
      const next = { ...row.value, keyEnvelope: reencrypted };
      await tx(table)
        .where({ company_id: row.company_id, key: row.key })
        .update({ value: next, updated_at: new Date() });
      decryptSecret(reencrypted, newRing, row.company_id);
    }
    return { rotated: rows.length };
  });
}

/* ---------------- CLI entry ---------------- */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const toVersion = flag("--to");
  const materialFile = flag("--material-file");
  if (!toVersion || !materialFile) {
    console.error(
      "usage: rotate-key --to v<N> --material-file <path> " +
        "(APP_KEY + MAINTENANCE_DATABASE_URL via env)",
    );
    process.exit(1);
  }
  const appKey = process.env.APP_KEY;
  const dbUrl = process.env.MAINTENANCE_DATABASE_URL;
  if (!appKey || !dbUrl) {
    console.error(
      "rotate-key: APP_KEY and MAINTENANCE_DATABASE_URL are required",
    );
    process.exit(1);
  }
  // Material comes off the protected mount and is never echoed.
  const toMaterial = readFileSync(materialFile, "utf8").trim();
  const db = createDb(dbUrl, { poolMax: 2 });
  try {
    const r = await rotateEnvelopes(db, {
      ring: parseKeyRing(appKey),
      toVersion,
      toMaterial,
    });
    console.log(
      `rotate-key: re-encrypted ${r.rotated} envelope(s) to ${toVersion} — ` +
        `append ${toVersion} to APP_KEY and keep the old version until the ` +
        "backup window expires.",
    );
  } catch (err) {
    console.error(
      "rotate-key failed:",
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  } finally {
    await db.destroy().catch(() => {});
  }
}
