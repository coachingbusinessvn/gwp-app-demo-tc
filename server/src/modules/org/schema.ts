import { z } from "zod";

/**
 * Request-body schemas for the org endpoints (task 1.1, spec §3/§4).
 *
 * Every schema is .strict(): generic profile/org payloads must reject
 * privilege fields (role, managerId, …) and any other unexpected key — the
 * only writable fields are the ones listed here.
 */
const nameField = z.string().trim().min(1).max(200);

// IANA timezone validation via Intl — the runtime carries full ICU, so an
// unknown identifier throws RangeError.
const timezoneField = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: "invalid IANA timezone" },
  );

export const createDepartmentBodySchema = z
  .object({ name: nameField })
  .strict();
export type CreateDepartmentBody = z.infer<typeof createDepartmentBodySchema>;

// Rename is the only mutable field of a department.
export const updateDepartmentBodySchema = z
  .object({ name: nameField })
  .strict();
export type UpdateDepartmentBody = z.infer<typeof updateDepartmentBodySchema>;

export const createTeamBodySchema = z
  .object({ name: nameField, departmentId: z.uuid() })
  .strict();
export type CreateTeamBody = z.infer<typeof createTeamBodySchema>;

export const updateTeamBodySchema = z
  .object({ name: nameField.optional(), departmentId: z.uuid().optional() })
  .strict();
export type UpdateTeamBody = z.infer<typeof updateTeamBodySchema>;

// Company profile PATCH — name and/or timezone; at least one field is
// required (enforced in the route so the error stays INVALID_INPUT).
export const updateCompanyBodySchema = z
  .object({ name: nameField.optional(), timezone: timezoneField.optional() })
  .strict();
export type UpdateCompanyBody = z.infer<typeof updateCompanyBodySchema>;

// Reporting line (task 1.2): managerId is a required key whose value is a
// uuid OR explicit null — null unassigns the subject's manager.
export const setManagerBodySchema = z
  .object({ managerId: z.uuid().nullable() })
  .strict();
export type SetManagerBody = z.infer<typeof setManagerBodySchema>;
