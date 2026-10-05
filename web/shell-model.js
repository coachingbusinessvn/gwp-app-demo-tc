/* web/shell-model.js — pure helpers behind the shared app shell and the
 * account page (no DOM, no network, no module-load side effects), so the
 * vitest unit suite can import them directly under Node.
 *
 * - shellNav: the one nav list every signed-in page shows. "Quản trị" is a
 *   UX entry only, derived from GET /auth/me roles — every admin API
 *   re-checks server-side.
 * - safeBranding: GET /settings/branding output narrowed to what the shell
 *   may apply — displayName as plain text, accentColor only as a strict
 *   #rrggbb (same rule as the server schema and web/admin/main.js), so a
 *   malformed stored value can never become CSS injection.
 * - profilePatch / passwordChangeError: client-side mirrors of the server
 *   schemas (users/schema.ts nameField/titleField, auth/schema.ts
 *   changePasswordBodySchema). The server stays authoritative; these only
 *   give an early, Vietnamese message before a round-trip.
 */

export const DEFAULT_BRAND_NAME = "GoWise Partners";
export const PASSWORD_MIN = 12; // auth/schema.ts: newPassword min(12)
export const PASSWORD_MAX = 256;
export const PROFILE_FIELD_MAX = 200; // users/schema.ts: name/title max(200)

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Owner/admin roles from /auth/me (DB truth, not the JWT). */
export function isAdminRole(roles) {
  return (
    Array.isArray(roles) && (roles.includes("owner") || roles.includes("admin"))
  );
}

/**
 * Nav entries for the shell, absolute paths so the same list works from
 * the root pages and from /canvas-online/ + /coaching-report/. `current`
 * is the key of the page being shown (or null).
 */
export function shellNav(roles, current = null) {
  const items = [
    { key: "dashboard", href: "/dashboard.html", label: "Bảng theo dõi" },
    // Canvas Online with no ?canvas= opens the create form — the entry
    // point for a second (third, …) canvas once the dashboard's empty-state
    // CTA is gone.
    { key: "canvas", href: "/canvas-online/", label: "Canvas Online" },
    // Every signed-in user may coach or be coached; which sessions and
    // reports they see is decided server-side by the report ACL.
    { key: "coaching", href: "/coaching-report/", label: "Coaching Report" },
  ];
  if (isAdminRole(roles)) {
    items.push({ key: "admin", href: "/admin.html", label: "Quản trị" });
  }
  return items.map((it) => ({ ...it, current: it.key === current }));
}

/** Branding narrowed to safe values; null when nothing usable came back. */
export function safeBranding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name =
    typeof raw.displayName === "string" ? raw.displayName.trim() : "";
  const accent =
    typeof raw.accentColor === "string" && HEX_COLOR.test(raw.accentColor)
      ? raw.accentColor
      : null;
  if (!name && !accent) return null;
  return { displayName: name || DEFAULT_BRAND_NAME, accentColor: accent };
}

/**
 * Tab title with the shipped brand suffix swapped for the company's
 * display name ("Bảng theo dõi — … | GoWise Partners" → "… | ACME").
 */
export function brandedTitle(title, displayName) {
  const t = String(title ?? "");
  const suffix = ` | ${DEFAULT_BRAND_NAME}`;
  if (!displayName || !t.endsWith(suffix)) return t;
  return t.slice(0, -suffix.length) + " | " + displayName;
}

/**
 * PATCH /users/:id body for a self-edit of name/title. Returns
 * { patch } with only the changed fields, { patch: null } when nothing
 * changed, or { error } with a user-facing message. An emptied title is
 * sent as null (the server's titleField requires min 1 when present).
 */
export function profilePatch(current, nameInput, titleInput) {
  const name = String(nameInput ?? "").trim();
  const title = String(titleInput ?? "").trim();
  if (!name) return { error: "Họ tên không được để trống." };
  if (name.length > PROFILE_FIELD_MAX || title.length > PROFILE_FIELD_MAX) {
    return { error: `Họ tên và chức danh tối đa ${PROFILE_FIELD_MAX} ký tự.` };
  }
  const patch = {};
  if (name !== (current?.name ?? "")) patch.name = name;
  const nextTitle = title === "" ? null : title;
  if (nextTitle !== (current?.title ?? null)) patch.title = nextTitle;
  return { patch: Object.keys(patch).length ? patch : null };
}

/** First client-side problem with a password-change form, or null. */
export function passwordChangeError(currentPassword, newPassword, confirm) {
  if (!currentPassword) return "Nhập mật khẩu hiện tại.";
  if (!newPassword || newPassword.length < PASSWORD_MIN) {
    return `Mật khẩu mới cần tối thiểu ${PASSWORD_MIN} ký tự.`;
  }
  if (newPassword.length > PASSWORD_MAX) {
    return `Mật khẩu mới tối đa ${PASSWORD_MAX} ký tự.`;
  }
  if (newPassword !== confirm) return "Mật khẩu nhập lại không khớp.";
  if (newPassword === currentPassword) {
    return "Mật khẩu mới phải khác mật khẩu hiện tại.";
  }
  return null;
}
