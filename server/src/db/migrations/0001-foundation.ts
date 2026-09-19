import type { Knex } from "knex";
import type { Migration } from "../migrate.js";

/**
 * 0001-foundation — spec §3 core model for Phase 0.
 *
 * Single-company deployment: `company` is a singleton enforced by the
 * `company_singleton` unique index on the constant expression `(true)` — every
 * row indexes identically, so a second INSERT is a 23505 unique violation. The
 * `singleton` flag column (CHECK true) exists so inserts that set the flag per
 * the plan's test contract fail with the same violation.
 *
 * Composite (company_id, …) foreign keys keep every cross-reference inside the
 * one company. department/team arrive in Phase 1; one_time_token and
 * write_receipt in later phases — deliberately absent here.
 */
export const foundationMigration: Migration = {
  name: "0001-foundation",
  async up(db: Knex): Promise<void> {
    await db.raw(`
      CREATE TABLE company (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
        singleton boolean NOT NULL DEFAULT true CHECK (singleton),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.raw(
      `CREATE UNIQUE INDEX company_singleton ON company ((true))`,
    );

    await db.raw(`
      CREATE TABLE app_user (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES company (id),
        email text NOT NULL,
        email_normalized text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
        name text NOT NULL,
        title text,
        password_hash text,
        manager_id uuid,
        status text NOT NULL CHECK (status IN ('pending', 'active', 'inactive')),
        auth_version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT app_user_email_unique UNIQUE (company_id, email_normalized),
        CONSTRAINT app_user_company_user_unique UNIQUE (company_id, id),
        CONSTRAINT active_password
          CHECK (status <> 'active' OR password_hash IS NOT NULL),
        CONSTRAINT manager_not_self
          CHECK (manager_id IS NULL OR manager_id <> id),
        CONSTRAINT app_user_manager_fk
          FOREIGN KEY (company_id, manager_id)
          REFERENCES app_user (company_id, id)
      )
    `);
    // spec §3 index list: user/company/manager lookups.
    await db.raw(
      `CREATE INDEX app_user_company_manager ON app_user (company_id, manager_id)`,
    );

    await db.raw(`
      CREATE TABLE role (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key text NOT NULL UNIQUE
          CHECK (key IN ('owner', 'admin', 'manager', 'member')),
        label text NOT NULL
      )
    `);
    await db.raw(`
      INSERT INTO role (key, label) VALUES
        ('owner', 'Chủ sở hữu'),
        ('admin', 'Quản trị viên'),
        ('manager', 'Quản lý'),
        ('member', 'Thành viên')
    `);

    await db.raw(`
      CREATE TABLE user_role (
        company_id uuid NOT NULL,
        user_id uuid NOT NULL,
        role_id uuid NOT NULL REFERENCES role (id),
        CONSTRAINT user_role_pk PRIMARY KEY (company_id, user_id, role_id),
        CONSTRAINT user_role_user_fk
          FOREIGN KEY (company_id, user_id)
          REFERENCES app_user (company_id, id)
      )
    `);

    await db.raw(`
      CREATE TABLE setting (
        company_id uuid NOT NULL REFERENCES company (id),
        key text NOT NULL,
        value jsonb NOT NULL,
        updated_by uuid,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT setting_pk PRIMARY KEY (company_id, key),
        CONSTRAINT setting_updated_by_fk
          FOREIGN KEY (company_id, updated_by)
          REFERENCES app_user (company_id, id)
      )
    `);

    await db.raw(`
      CREATE TABLE deployment_state (
        singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
        mode text NOT NULL CHECK (mode IN ('demo','production')),
        setup_completed_at timestamptz,
        seed_version integer NOT NULL DEFAULT 0
      )
    `);

    await db.raw(`
      CREATE TABLE auth_session (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        user_id uuid NOT NULL,
        token_family_id uuid NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT auth_session_company_session_unique UNIQUE (company_id, id),
        CONSTRAINT auth_session_user_fk
          FOREIGN KEY (company_id, user_id)
          REFERENCES app_user (company_id, id)
      )
    `);
    await db.raw(
      `CREATE INDEX auth_session_user ON auth_session (user_id)`,
    );

    await db.raw(`
      CREATE TABLE refresh_token (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES auth_session (id),
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        replaced_by uuid REFERENCES refresh_token (id)
      )
    `);
    await db.raw(
      `CREATE INDEX refresh_token_session ON refresh_token (session_id)`,
    );

    await db.raw(`
      CREATE TABLE audit_event (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES company (id),
        actor_id uuid,
        action text NOT NULL,
        target_type text,
        target_id uuid,
        outcome text NOT NULL,
        safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        request_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT audit_event_actor_fk
          FOREIGN KEY (company_id, actor_id)
          REFERENCES app_user (company_id, id)
      )
    `);
    // spec §3 index list: audit/company/time.
    await db.raw(
      `CREATE INDEX audit_event_company_created ON audit_event (company_id, created_at)`,
    );
  },
};
