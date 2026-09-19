import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Knex } from "knex";
import type { DemoMode } from "../config.js";
import { appendAudit } from "../modules/audit/service.js";
import { hashPassword } from "../modules/auth/password.js";
import { AppError } from "../shared/errors.js";
import { createDb } from "./connection.js";
import {
  DEMO_IDENTITIES,
  DEMO_PASSWORD,
  type DemoId,
} from "./demo-identities.js";

/**
 * Demo seed — IDENTITIES ONLY at Phase 0 (canvas seed is Phase 2).
 *
 * Spec §8: demo mode is an immutable property of the database, so this
 * refuses unless deployment_state.mode === 'demo' AND first-run setup has
 * completed. Idempotent via deployment_state.seed_version — a second run is
 * a version-skip no-op. Runs as the runtime credential (no DDL needed).
 *
 * All demo users share the published demo password hashed once — the
 * credential is public by design, so per-user salts would only burn CPU.
 */
export const DEMO_SEED_VERSION = 1;

export async function seedDemo(
  db: Knex,
  expectedMode: DemoMode,
): Promise<void> {
  if (expectedMode !== "demo") {
    throw new AppError(
      400,
      "MODE_MISMATCH",
      "seedDemo chỉ hỗ trợ chế độ demo — không seed production",
    );
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await db.transaction(async (tx) => {
    const state = await tx("deployment_state")
      .where({ singleton_id: 1 })
      .forUpdate()
      .first();
    if (!state || state.mode !== "demo") {
      throw new AppError(
        409,
        "MODE_MISMATCH",
        "Demo seed chỉ chạy trên deployment demo",
      );
    }
    if (!state.setup_completed_at) {
      throw new AppError(
        409,
        "SETUP_REQUIRED",
        "Hoàn tất setup trước khi seed demo",
      );
    }
    // Idempotent: this or a newer seed already applied.
    if (state.seed_version >= DEMO_SEED_VERSION) return;

    const company = await tx("company").select("id").first();
    if (!company) {
      // setup_completed_at implies a company exists — defensive only.
      throw new AppError(500, "COMPANY_MISSING", "Thiếu company sau setup");
    }
    const companyId = company.id as string;

    const roleIdByKey = new Map<string, string>(
      (await tx("role").select("id", "key")).map(
        (r: { id: string; key: string }) => [r.key, r.id],
      ),
    );

    // DEMO_IDENTITIES iterates parents before children (org order), so the
    // composite manager FK resolves within the same pass.
    const idByDemoId = new Map<DemoId, string>();
    for (const [demoId, ident] of Object.entries(DEMO_IDENTITIES)) {
      const userId = ident.demoUserId;
      idByDemoId.set(demoId as DemoId, userId);
      await tx("app_user").insert({
        id: userId,
        company_id: companyId,
        email: ident.email,
        name: ident.name,
        title: ident.title,
        status: "active",
        password_hash: passwordHash,
        manager_id: ident.managerDemoId
          ? idByDemoId.get(ident.managerDemoId)
          : null,
      });
      const roleId = roleIdByKey.get(ident.role);
      if (!roleId) {
        throw new AppError(500, "ROLE_MISSING", `Thiếu role ${ident.role}`);
      }
      await tx("user_role").insert({
        company_id: companyId,
        user_id: userId,
        role_id: roleId,
      });
    }

    await appendAudit(tx, {
      companyId,
      action: "demo.seed",
      outcome: "success",
      requestId: randomUUID(), // operator command — no HTTP request id
      metadata: {
        mode: "demo",
        version: DEMO_SEED_VERSION,
        count: Object.keys(DEMO_IDENTITIES).length,
      },
    });
    await tx("deployment_state")
      .where({ singleton_id: 1 })
      .update({ seed_version: DEMO_SEED_VERSION });
  });
}

// `npm run db:seed-demo` entrypoint — runtime credential (DML only), refuses
// non-demo deployments twice: DEMO_MODE env and deployment_state.mode.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("db:seed-demo requires DATABASE_URL");
    const scheme = new URL(url).protocol.replace(/:$/, "");
    if (scheme !== "postgres" && scheme !== "postgresql")
      throw new Error(
        `db:seed-demo connection URL must be a postgres:// URL, got scheme "${scheme}"`,
      );
    const mode = process.env.DEMO_MODE ?? "production";
    if (mode !== "demo" && mode !== "production")
      throw new Error(`DEMO_MODE must be "demo" or "production", got "${mode}"`);
    const db = createDb(url);
    try {
      await seedDemo(db, mode);
      console.log("db:seed-demo complete — demo identities seeded");
    } finally {
      await db.destroy().catch(() => {});
    }
  } catch (err) {
    console.error(
      "db:seed-demo failed:",
      err instanceof AppError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : err,
    );
    process.exit(1);
  }
}
