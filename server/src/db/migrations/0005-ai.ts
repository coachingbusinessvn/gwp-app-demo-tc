import type { Knex } from "knex";
import type { Migration } from "../migrate.js";

/**
 * 0005-ai — AI run metadata for Phase 3 (task 3.3, spec §7.3).
 *
 * `ai_run` stores METADATA ONLY: status, lifecycle timestamps, the
 * idempotency key, the SHA-256 input hash, provenance (model/key/prompt
 * version), the captured canvas base (version + draft revision at start),
 * consent timestamp, and usage counters when the endpoint reports them.
 * It NEVER stores raw input (notes, canvas snapshot, prompts) or raw output
 * (transcripts, proposals) — those live only in memory for the run's
 * lifetime plus the bounded ephemeral preview (§7.3).
 *
 * Invariants:
 * - (company_id, actor_id, assistant, idempotency_key) UNIQUE — a retried
 *   start resolves to the same row; the service compares input_hash and
 *   turns a key-reuse-with-different-input into 409.
 * - Composite FKs to app_user/canvas/canvas_version keep every reference
 *   inside the one company — same discipline as 0004.
 * - status CHECK is the full lifecycle enum; 'interrupted' is written by
 *   the boot sweep for rows left queued/running by a crash or restart.
 * - base_version_id + captured_draft_revision record the exact canvas base
 *   the run was admitted against so apply can refuse a moved target.
 * - The runtime role may UPDATE ai_run (status transitions); there is no
 *   delete path in the app — retention cleanup runs as the maintenance
 *   role per spec §9 (AI metadata 90 days).
 */
export const aiMigration: Migration = {
  name: "0005-ai",
  async up(db: Knex): Promise<void> {
    await db.raw(`
      CREATE TABLE ai_run (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        actor_id uuid NOT NULL,
        assistant text NOT NULL
          CHECK (assistant IN ('renderer', 'coach')),
        canvas_id uuid NOT NULL,
        status text NOT NULL DEFAULT 'queued'
          CHECK (status IN (
            'queued', 'running', 'succeeded',
            'failed', 'cancelled', 'interrupted'
          )),
        idempotency_key text NOT NULL,
        input_hash text NOT NULL,
        consent_at timestamptz NOT NULL,
        base_version_id uuid,
        captured_draft_revision integer,
        prompt_version text,
        config_key_version text,
        config_model text,
        error_code text,
        usage_input_tokens integer,
        usage_output_tokens integer,
        request_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz,
        CONSTRAINT ai_run_company_id_unique UNIQUE (company_id, id),
        CONSTRAINT ai_run_actor_fk
          FOREIGN KEY (company_id, actor_id)
          REFERENCES app_user (company_id, id),
        CONSTRAINT ai_run_canvas_fk
          FOREIGN KEY (company_id, canvas_id)
          REFERENCES canvas (company_id, id),
        CONSTRAINT ai_run_base_version_fk
          FOREIGN KEY (company_id, canvas_id, base_version_id)
          REFERENCES canvas_version (company_id, canvas_id, id),
        CONSTRAINT ai_run_idem
          UNIQUE (company_id, actor_id, assistant, idempotency_key)
      )
    `);

    // Admission counts active runs per company; run lookups resolve by id.
    await db.raw(
      `CREATE INDEX ai_run_company_status ON ai_run (company_id, status)`,
    );
  },
};
