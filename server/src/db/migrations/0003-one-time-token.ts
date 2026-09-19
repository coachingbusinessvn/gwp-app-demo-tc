import type { Knex } from "knex";
import type { Migration } from "../migrate.js";

/**
 * 0003-one-time-token — one-time credential tokens for activation and
 * owner-issued password reset (spec §8, task 1.4).
 *
 * - The raw token NEVER reaches the database: token_hash holds the SHA-256
 *   hex digest of the 256-bit random token and is UNIQUE — the same index
 *   serves the consume lookup (SELECT ... WHERE token_hash = ... FOR UPDATE).
 * - purpose ∈ {activate, reset} is bound at issuance: 'activate' is valid
 *   only for pending users, 'reset' only for active ones — enforced in the
 *   service; the CHECK just keeps the column honest.
 * - Composite (company_id, …) foreign keys keep every reference inside the
 *   one company, exactly like app_user/user_role in 0001.
 * - used_at doubles as the invalidation marker: consuming sets it, and
 *   issuing a fresh token for the same (user, purpose) marks the previous
 *   unused rows used — superseded tokens read exactly like consumed ones.
 * - created_by records the issuing owner (the actor); the consume path
 *   writes no token rows, only used_at.
 */
export const oneTimeTokenMigration: Migration = {
  name: "0003-one-time-token",
  async up(db: Knex): Promise<void> {
    await db.raw(`
      CREATE TABLE one_time_token (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        user_id uuid NOT NULL,
        token_hash text NOT NULL,
        purpose text NOT NULL CHECK (purpose IN ('activate', 'reset')),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT one_time_token_hash_unique UNIQUE (token_hash),
        CONSTRAINT one_time_token_user_fk
          FOREIGN KEY (company_id, user_id)
          REFERENCES app_user (company_id, id),
        CONSTRAINT one_time_token_created_by_fk
          FOREIGN KEY (company_id, created_by)
          REFERENCES app_user (company_id, id)
      )
    `);
    // Supersede sweep + per-user listing; consume itself uses the
    // token_hash unique index above.
    await db.raw(
      `CREATE INDEX one_time_token_user_purpose ON one_time_token (user_id, purpose)`,
    );
  },
};
