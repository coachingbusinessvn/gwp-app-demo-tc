import type { Knex } from "knex";
import type { Migration } from "../migrate.js";

/**
 * 0006-coaching — coaching sessions, reports and shares for Phase 4
 * (task 4.1, spec §3/§6).
 *
 * - coaching_session: a recorded 1-1 session — coach, coachee, optional
 *   canvas link, when it happened, who entered it. Append-only for the
 *   runtime role: sessions are records of fact, never edited in place
 *   (UPDATE/DELETE revoked in migrate.ts's enforceRuntimeRestrictions and
 *   the bootstrap script — same discipline as audit_event).
 * - coaching_report: an immutable versioned snapshot of one grading
 *   outcome. UNIQUE(session_id, report_version) makes re-grading produce a
 *   NEW row, never an edit — UPDATE is revoked for the runtime role while
 *   DELETE stays so task 4.3's confirmed deleteReport can remove a report
 *   and its shares (spec §6). ai_run_id is a composite FK with
 *   ON DELETE SET NULL (ai_run_id): retention may purge the run row while
 *   the report keeps its immutable provenance copy (spec §6).
 * - report_share: explicit per-version grants to same-company users —
 *   UNIQUE(report_id, user_id), revoked_at for soft revocation. Shares
 *   ride the report row, so a new report_version never inherits them.
 *   CASCADE on report delete: a deleted report takes its shares with it.
 *
 * Every cross-reference is a composite (company_id, …) FK — nothing can
 * point outside the one company, same discipline as 0004/0005.
 */
export const coachingMigration: Migration = {
  name: "0006-coaching",
  async up(db: Knex): Promise<void> {
    await db.raw(`
      CREATE TABLE coaching_session (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        coach_user_id uuid NOT NULL,
        coachee_user_id uuid NOT NULL,
        canvas_id uuid,
        occurred_at timestamptz NOT NULL,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT coaching_session_company_id_unique UNIQUE (company_id, id),
        -- A session records coaching OF someone BY someone else.
        CONSTRAINT coaching_session_distinct
          CHECK (coach_user_id <> coachee_user_id),
        CONSTRAINT coaching_session_coach_fk
          FOREIGN KEY (company_id, coach_user_id)
          REFERENCES app_user (company_id, id),
        CONSTRAINT coaching_session_coachee_fk
          FOREIGN KEY (company_id, coachee_user_id)
          REFERENCES app_user (company_id, id),
        CONSTRAINT coaching_session_canvas_fk
          FOREIGN KEY (company_id, canvas_id)
          REFERENCES canvas (company_id, id),
        CONSTRAINT coaching_session_created_by_fk
          FOREIGN KEY (company_id, created_by)
          REFERENCES app_user (company_id, id)
      )
    `);

    await db.raw(`
      CREATE TABLE coaching_report (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        session_id uuid NOT NULL,
        ai_run_id uuid,
        report_version integer NOT NULL,
        rubric_version text,
        body jsonb NOT NULL,
        provenance jsonb,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        -- Re-grading a session produces a NEW version row; reports are
        -- immutable per version (spec §6).
        CONSTRAINT coaching_report_version UNIQUE (session_id, report_version),
        CONSTRAINT coaching_report_company_id_unique UNIQUE (company_id, id),
        CONSTRAINT coaching_report_session_fk
          FOREIGN KEY (company_id, session_id)
          REFERENCES coaching_session (company_id, id),
        -- Retention deletes ai_run metadata without touching the saved
        -- report: column-list SET NULL drops only the reference.
        CONSTRAINT coaching_report_run_fk
          FOREIGN KEY (company_id, ai_run_id)
          REFERENCES ai_run (company_id, id)
          ON DELETE SET NULL (ai_run_id),
        CONSTRAINT coaching_report_created_by_fk
          FOREIGN KEY (company_id, created_by)
          REFERENCES app_user (company_id, id)
      )
    `);

    await db.raw(`
      CREATE TABLE report_share (
        company_id uuid NOT NULL,
        report_id uuid NOT NULL,
        user_id uuid NOT NULL,
        granted_by uuid NOT NULL,
        granted_at timestamptz NOT NULL DEFAULT now(),
        revoked_at timestamptz,
        -- One grant row per (report, user): re-share after revoke updates
        -- this row; a new report_version gets a fresh, empty share set.
        CONSTRAINT report_share_unique UNIQUE (report_id, user_id),
        CONSTRAINT report_share_report_fk
          FOREIGN KEY (company_id, report_id)
          REFERENCES coaching_report (company_id, id)
          ON DELETE CASCADE,
        CONSTRAINT report_share_user_fk
          FOREIGN KEY (company_id, user_id)
          REFERENCES app_user (company_id, id),
        CONSTRAINT report_share_granted_by_fk
          FOREIGN KEY (company_id, granted_by)
          REFERENCES app_user (company_id, id)
      )
    `);

    // Read paths: report detail resolves by (company_id, id); the scoped
    // list filters by coachee over the session join; share lookup is by
    // (report_id, user_id) — covered by report_share_unique.
    await db.raw(
      `CREATE INDEX coaching_session_coachee
         ON coaching_session (company_id, coachee_user_id)`,
    );
    await db.raw(
      `CREATE INDEX coaching_report_session
         ON coaching_report (company_id, session_id)`,
    );
    await db.raw(
      `CREATE INDEX report_share_user
         ON report_share (company_id, user_id)`,
    );
  },
};
