import { z } from "zod";
import type { Role } from "../../shared/contracts.js";

/**
 * Request-body schemas for the user endpoints (task 1.3, spec §3/§4).
 *
 * Every schema is .strict(): generic user payloads must reject privilege and
 * identity fields (role/roles, managerId, email on PATCH, password, status)
 * — the only writable fields are the ones listed here. Privilege changes
 * have their own routes with their own gates.
 */
const nameField = z.string().trim().min(1).max(200);
const titleField = z.string().trim().min(1).max(200);

export const ROLE_KEYS = ["owner", "admin", "manager", "member"] as const;
const roleKeySchema = z.enum(ROLE_KEYS);

/**
 * PUT /users/:id/roles — owner only. `roles` is the FULL replacement set
 * (union semantics over the allowlist); unknown keys fail the enum → 400.
 * An empty array is a legal set — the account keeps no roles (access removal
 * belongs to deactivate; the last-owner guard still applies).
 */
export const setRolesBodySchema = z
  .object({ roles: z.array(roleKeySchema).max(ROLE_KEYS.length) })
  .strict();
export type SetRolesBody = z.infer<typeof setRolesBodySchema>;

/**
 * POST /users — owner/admin. Creates a PENDING member: no password (the
 * active_password CHECK only demands a hash for active rows), no manager
 * (admin tạo member chưa gán manager — owner gán sau), role member only.
 * Activation is a separate one-time-token flow (task 1.4).
 */
export const createUserBodySchema = z
  .object({
    email: z.email().max(320),
    name: nameField,
    title: titleField.optional(),
    departmentId: z.uuid().optional(),
    teamId: z.uuid().optional(),
  })
  .strict();
export type CreateUserBody = z.infer<typeof createUserBodySchema>;

/**
 * PATCH /users/:id — non-privileged profile fields only. Explicit null on
 * title/departmentId/teamId clears the value; teamId always pins the
 * department to the team's own (composite FK). At least one field is
 * required — enforced in the route so the error stays INVALID_INPUT.
 */
export const updateUserBodySchema = z
  .object({
    name: nameField.optional(),
    title: titleField.nullable().optional(),
    departmentId: z.uuid().nullable().optional(),
    teamId: z.uuid().nullable().optional(),
  })
  .strict();
export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

/**
 * POST /users/:id/deactivate — owner/admin. `replacementManagerId` is the
 * reports decision: absent → 403 when the target still has active reports;
 * explicit null → reports become unassigned; uuid → reports transfer to that
 * (active, same-company, non-subtree) user.
 */
export const deactivateUserBodySchema = z
  .object({ replacementManagerId: z.uuid().nullable().optional() })
  .strict();
export type DeactivateUserBody = z.infer<typeof deactivateUserBodySchema>;

export type { Role };
