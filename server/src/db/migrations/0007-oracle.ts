import type { Knex } from "knex";
import type { Migration } from "../migrate.js";

/**
 * 0007-oracle — extend ai_run for the ORACLE grader assistant
 * (task 4.2, spec §6/§7.3).
 *
 * The grader is bound to a coaching SESSION, not a canvas: canvas_id
 * becomes optional and session_id joins coaching_session. The
 * ai_run_target_check keeps the two shapes mutually exclusive — a run is
 * either a canvas run (renderer/coach) or a session run (oracle), never
 * both, never neither.
 *
 * The transcript itself is NEVER stored — same rule as notes: it is
 * hashed into input_hash at admission and lives only in process memory
 * for the run's lifetime. ai_run rows stay metadata-only.
 */
export const oracleMigration: Migration = {
  name: "0007-oracle",
  async up(db: Knex): Promise<void> {
    await db.raw(`
      ALTER TABLE ai_run
        ALTER COLUMN canvas_id DROP NOT NULL,
        ADD COLUMN session_id uuid
    `);
    await db.raw(`
      ALTER TABLE ai_run
        DROP CONSTRAINT ai_run_assistant_check,
        ADD CONSTRAINT ai_run_assistant_check
          CHECK (assistant IN ('renderer', 'coach', 'oracle')),
        ADD CONSTRAINT ai_run_session_fk
          FOREIGN KEY (company_id, session_id)
          REFERENCES coaching_session (company_id, id),
        ADD CONSTRAINT ai_run_target_check CHECK (
          (assistant = 'oracle'
            AND session_id IS NOT NULL AND canvas_id IS NULL)
          OR (assistant <> 'oracle'
            AND canvas_id IS NOT NULL AND session_id IS NULL)
        )
    `);
  },
};
