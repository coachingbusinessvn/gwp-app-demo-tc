import type { Knex } from "knex";
import type { Migration } from "../migrate.js";

/**
 * 0004-canvas — canvas persistence for Phase 2 (task 2.3, spec §3/§5).
 *
 * Three tables, every cross-reference a composite (company_id, …) foreign
 * key so nothing can point outside the one company:
 *
 * - canvas: one owner per canvas (owner_user_id → app_user), a `name` that
 *   backs list/detail display, status 'active'|'archived' (archive is a
 *   flag, never a delete — spec §9), and a nullable current_version_id
 *   that is wired up as a THREE-column FK (company_id, id,
 *   current_version_id) → canvas_version (company_id, canvas_id, id) after
 *   both tables exist, so the pointer can never reference another canvas's
 *   version (spec §3 invariant).
 * - canvas_version: immutable published snapshots. UNIQUE(canvas_id,
 *   version_no) plus UNIQUE(company_id, canvas_id, id) as the FK target
 *   for both canvas.current_version_id and canvas_draft.base_version_id.
 *   Immutability is enforced at the DB role level — gwp_runtime gets
 *   UPDATE/DELETE revoked in migrate.ts's enforceRuntimeRestrictions (and
 *   the bootstrap script), same discipline as audit_event. There is no
 *   version-mutation route at all.
 * - canvas_draft: at most one shared draft per canvas — the
 *   canvas_one_draft UNIQUE INDEX on canvas_id is the hard guarantee;
 *   the service turns a collision into 409 rather than overwriting
 *   in-progress work. base_version_id binds the draft to the published
 *   version it branched from (same triple-column FK as current_version_id).
 *   source ∈ {manual, import, ai} records how the draft was created
 *   (import/ai land in later phases; the API writes 'manual').
 * - write_receipt (task 2.4): idempotent-write receipts keyed by
 *   (scope, key). The scope string is caller-namespaced (e.g.
 *   "canvas.publish:<companyId>:<canvasId>") so one table serves every
 *   idempotent write without cross-resource collisions; request_hash
 *   detects same-key/different-payload reuse (409), result_id points at
 *   the row the write produced. Retention is 7 days: lookups ignore older
 *   rows and the same-key insert reclaims the slot — a periodic janitor
 *   DELETE on created_at bounds table growth but is not required for
 *   correctness.
 *
 * Indexes follow spec §3's query list: scoped lists filter by
 * (company_id, owner_user_id); version lookups resolve by
 * (canvas_id, version_no) — covered by the unique constraint — and drafts
 * resolve by canvas_id via the unique index. Receipt lookups hit the
 * (scope, key) unique index directly.
 */
export const canvasMigration: Migration = {
  name: "0004-canvas",
  async up(db: Knex): Promise<void> {
    await db.raw(`
      CREATE TABLE canvas (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES company (id),
        owner_user_id uuid NOT NULL,
        name text NOT NULL,
        status text NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived')),
        current_version_id uuid,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz,
        archived_by uuid,
        -- The composite-FK target every canvas child/reference needs.
        CONSTRAINT canvas_company_id_unique UNIQUE (company_id, id),
        CONSTRAINT canvas_owner_fk
          FOREIGN KEY (company_id, owner_user_id)
          REFERENCES app_user (company_id, id),
        CONSTRAINT canvas_created_by_fk
          FOREIGN KEY (company_id, created_by)
          REFERENCES app_user (company_id, id),
        CONSTRAINT canvas_archived_by_fk
          FOREIGN KEY (company_id, archived_by)
          REFERENCES app_user (company_id, id),
        -- archived_at/archived_by travel with the status flag.
        CONSTRAINT canvas_archive_consistent
          CHECK (
            (status = 'archived')
            = (archived_at IS NOT NULL AND archived_by IS NOT NULL)
          )
      )
    `);

    await db.raw(`
      CREATE TABLE canvas_version (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        canvas_id uuid NOT NULL,
        version_no integer NOT NULL,
        schema_version integer NOT NULL,
        body jsonb NOT NULL,
        change_summary text,
        provenance jsonb,
        published_by uuid NOT NULL,
        published_at timestamptz NOT NULL DEFAULT now(),
        -- spec §3: one version number per canvas, monotonic by service rule.
        CONSTRAINT canvas_version_number UNIQUE (canvas_id, version_no),
        -- FK target so canvas.current_version_id and
        -- canvas_draft.base_version_id can only point at a version of THE
        -- SAME canvas inside the same company.
        CONSTRAINT canvas_version_company_canvas_id_unique
          UNIQUE (company_id, canvas_id, id),
        CONSTRAINT canvas_version_canvas_fk
          FOREIGN KEY (company_id, canvas_id)
          REFERENCES canvas (company_id, id),
        CONSTRAINT canvas_version_published_by_fk
          FOREIGN KEY (company_id, published_by)
          REFERENCES app_user (company_id, id)
      )
    `);

    // Circular edge, added only after canvas_version exists: the pointer
    // carries (company_id, canvas.id, version.id) so it cannot escape to
    // another canvas's history.
    await db.raw(`
      ALTER TABLE canvas
        ADD CONSTRAINT canvas_current_version_fk
        FOREIGN KEY (company_id, id, current_version_id)
        REFERENCES canvas_version (company_id, canvas_id, id)
    `);

    await db.raw(`
      CREATE TABLE canvas_draft (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        canvas_id uuid NOT NULL,
        base_version_id uuid,
        revision integer NOT NULL DEFAULT 1,
        schema_version integer NOT NULL,
        body jsonb NOT NULL,
        source text NOT NULL DEFAULT 'manual'
          CHECK (source IN ('manual', 'import', 'ai')),
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT canvas_draft_company_id_unique UNIQUE (company_id, id),
        CONSTRAINT canvas_draft_canvas_fk
          FOREIGN KEY (company_id, canvas_id)
          REFERENCES canvas (company_id, id),
        CONSTRAINT canvas_draft_base_version_fk
          FOREIGN KEY (company_id, canvas_id, base_version_id)
          REFERENCES canvas_version (company_id, canvas_id, id),
        CONSTRAINT canvas_draft_created_by_fk
          FOREIGN KEY (company_id, created_by)
          REFERENCES app_user (company_id, id),
        CONSTRAINT canvas_draft_updated_by_fk
          FOREIGN KEY (company_id, updated_by)
          REFERENCES app_user (company_id, id)
      )
    `);

    // spec §3: at most one live draft per canvas — service maps a collision
    // to 409 DRAFT_EXISTS; the index is the guarantee that survives races.
    await db.raw(
      `CREATE UNIQUE INDEX canvas_one_draft ON canvas_draft (canvas_id)`,
    );
    // spec §3 index list: scoped lists filter canvas by owner inside the
    // company; version lookups by (canvas_id, version_no) are covered by
    // canvas_version_number above.
    await db.raw(
      `CREATE INDEX canvas_company_owner ON canvas (company_id, owner_user_id)`,
    );

    // Idempotent-write receipts (task 2.4): a retried write with the same
    // (scope, key) replays its stored result instead of applying twice;
    // the same key with a different request_hash is a 409 conflict.
    // created_at carries the 7-day retention window — the lookup in
    // shared/write-receipt.ts treats older rows as expired and reclaims
    // the (scope, key) slot, and a janitor can DELETE by created_at for
    // table growth (correctness does not depend on it).
    await db.raw(`
      CREATE TABLE write_receipt (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scope text NOT NULL,
        key text NOT NULL,
        request_hash text NOT NULL,
        result_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT write_receipt_scope_key UNIQUE (scope, key)
      )
    `);
  },
};
