/**
 * Ambient types for the plain-JS shell helpers (web/shell-model.js) —
 * only the surface the unit tests touch. The module stays JS so the
 * browser loads it without a build step.
 */
declare module "*/web/shell-model.js" {
  export const DEFAULT_BRAND_NAME: string;
  export const PASSWORD_MIN: number;
  export const PASSWORD_MAX: number;
  export const PROFILE_FIELD_MAX: number;
  export function isAdminRole(roles: unknown): boolean;
  export function shellNav(
    roles: unknown,
    current?: string | null,
  ): { key: string; href: string; label: string; current: boolean }[];
  export function safeBranding(
    raw: unknown,
  ): { displayName: string; accentColor: string | null } | null;
  export function brandedTitle(title: string, displayName: string | null): string;
  export function profilePatch(
    current: { name?: string; title?: string | null } | null,
    nameInput: string,
    titleInput: string,
  ):
    | { error: string; patch?: undefined }
    | { patch: { name?: string; title?: string | null } | null; error?: undefined };
  export function passwordChangeError(
    currentPassword: string,
    newPassword: string,
    confirm: string,
  ): string | null;
}
