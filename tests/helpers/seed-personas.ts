import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { hashPassword } from "../../server/src/modules/auth/password.js";
import type { Id, Role } from "../../server/src/shared/contracts.js";

export type Persona = "owner" | "admin" | "manager" | "member" | "outsider";

/** All seeded personas share this literal password (test-only). */
export const FIXTURE_PASSWORD = "fixture-password";
export const personaEmail = (p: Persona): string => `${p}@example.test`;

export const PERSONAS: readonly Persona[] = [
  "owner",
  "admin",
  "manager",
  "member",
  "outsider",
];

/**
 * Persona wiring (task 0.4): everyone is an active user of the company with
 * the argon2id hash of FIXTURE_PASSWORD. member reports to manager; outsider
 * is a member reporting directly to owner — inside the company but OUTSIDE
 * manager's subtree (for cross-subtree deny tests). Insertion order follows
 * PERSONAS so the composite manager FK always resolves to an earlier row.
 */
export const PERSONA_SEED: Record<
  Persona,
  { role: Role; manager: Persona | null }
> = {
  owner: { role: "owner", manager: null },
  admin: { role: "admin", manager: null },
  manager: { role: "manager", manager: "owner" },
  member: { role: "member", manager: "manager" },
  outsider: { role: "member", manager: "owner" },
};

export function generatePersonaIds(): Record<Persona, Id> {
  return Object.fromEntries(
    PERSONAS.map((p) => [p, randomUUID()]),
  ) as Record<Persona, Id>;
}

/**
 * Test-only SQL seed: inserts the five personas under `companyId` on the
 * given (already migrated) connection. Shared by the vitest fixture and the
 * Playwright e2e global-setup — one definition, never duplicated.
 */
export async function seedPersonas(
  db: Knex,
  companyId: Id,
  personaIds: Record<Persona, Id>,
): Promise<void> {
  // One hash for all five — the credential is a published fixture, so
  // per-user salts would only burn CPU (same rule as the demo seed).
  const passwordHash = await hashPassword(FIXTURE_PASSWORD);
  const roleIdByKey = new Map<string, string>(
    (await db("role").select("id", "key")).map(
      (r: { id: string; key: string }) => [r.key, r.id],
    ),
  );
  for (const persona of PERSONAS) {
    const seed = PERSONA_SEED[persona];
    await db("app_user").insert({
      id: personaIds[persona],
      company_id: companyId,
      email: personaEmail(persona),
      name: `Fixture ${persona.charAt(0).toUpperCase()}${persona.slice(1)}`,
      title: "Fixture User",
      status: "active",
      password_hash: passwordHash,
      manager_id: seed.manager ? personaIds[seed.manager] : null,
    });
    const roleId = roleIdByKey.get(seed.role);
    if (!roleId) throw new Error(`fixture: role ${seed.role} not seeded`);
    await db("user_role").insert({
      company_id: companyId,
      user_id: personaIds[persona],
      role_id: roleId,
    });
  }
}

/**
 * Company + five personas in one helper — returns the real ids. Caller must
 * supply a migrated connection (migrator credential for fresh schemas/DBs).
 */
export async function seedCompanyWithPersonas(
  db: Knex,
  companyName = "GWP Test Company",
  personaIds: Record<Persona, Id> = generatePersonaIds(),
): Promise<{ companyId: Id; personaIds: Record<Persona, Id> }> {
  const inserted = await db("company")
    .insert({ name: companyName })
    .returning("id");
  const companyId = (inserted[0] as { id: string }).id;
  await seedPersonas(db, companyId, personaIds);
  return { companyId, personaIds };
}
