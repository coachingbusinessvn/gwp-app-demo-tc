import type { Knex } from "knex";
import type { Migration } from "../migrate.js";

/**
 * 0002-organization — spec §3 org structure for Phase 1 (task 1.1).
 *
 * company → department → team is the administrative tree. As in 0001, every
 * cross-reference is a composite (company_id, …) foreign key so a reference
 * can never escape the one company:
 *
 * - department/team carry UNIQUE (company_id, id) — the target a composite
 *   FK elsewhere needs — and team additionally carries
 *   UNIQUE (company_id, department_id, id).
 * - team (company_id, department_id) → department (company_id, id): a team
 *   cannot point at a department outside its company.
 * - app_user gains department_id/team_id with TWO composite FKs:
 *     (company_id, department_id)            → department (company_id, id)
 *     (company_id, department_id, team_id)   → team (company_id, department_id, id)
 *   The triple-column FK makes "user in team T but a different department
 *   than T's" impossible at the DB level — spec §3's invariant
 *   "team.department_id phải khớp user.department_id nếu user có team".
 *   A CHECK forces department_id to be set whenever team_id is.
 *
 * Archive is a flag (archived_at), never a delete: referenced units keep
 * their rows so historical FKs survive — the 409 in-use check lives in the
 * service layer (org/service.ts), not in a cascade.
 */
export const organizationMigration: Migration = {
  name: "0002-organization",
  async up(db: Knex): Promise<void> {
    await db.raw(`
      CREATE TABLE department (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES company (id),
        name text NOT NULL,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT department_company_id_unique UNIQUE (company_id, id)
      )
    `);

    await db.raw(`
      CREATE TABLE team (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES company (id),
        department_id uuid NOT NULL,
        name text NOT NULL,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT team_company_id_unique UNIQUE (company_id, id),
        -- FK target for app_user(company_id, department_id, team_id): binds a
        -- user's team to the SAME department the user is assigned to.
        CONSTRAINT team_company_department_id_unique
          UNIQUE (company_id, department_id, id),
        CONSTRAINT team_department_company_fk
          FOREIGN KEY (company_id, department_id)
          REFERENCES department (company_id, id)
      )
    `);

    await db.raw(`
      ALTER TABLE app_user
        ADD COLUMN department_id uuid,
        ADD COLUMN team_id uuid,
        ADD CONSTRAINT app_user_department_fk
          FOREIGN KEY (company_id, department_id)
          REFERENCES department (company_id, id),
        ADD CONSTRAINT app_user_team_fk
          FOREIGN KEY (company_id, department_id, team_id)
          REFERENCES team (company_id, department_id, id),
        ADD CONSTRAINT app_user_team_requires_department
          CHECK (team_id IS NULL OR department_id IS NOT NULL)
    `);

    // spec §3 index list: archive reference checks + org listing by company.
    await db.raw(
      `CREATE INDEX app_user_company_department ON app_user (company_id, department_id)`,
    );
    await db.raw(
      `CREATE INDEX app_user_company_team ON app_user (company_id, team_id)`,
    );
  },
};
