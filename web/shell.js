/* web/shell.js — shared app shell for every signed-in, non-admin page.
 *
 * Two ways in:
 *   1. Account-shell pages (dashboard / employee / canvas / account) import
 *      renderAppHeader + renderAppFooter and build the compact header.app
 *      bar after requireAuth() resolved the identity.
 *   2. Pages that own a static hero header (canvas-online/, coaching-report/)
 *      only include this file as a module script. Their header markup
 *      carries a `[data-shell-nav]` nav with hidden placeholders
 *      (`[data-shell-admin]`, `[data-shell-account]`, `[data-shell-logout]`);
 *      the self-mount below fills them from GET /auth/me. It never
 *      redirects — the page's own script keeps the requireAuth gate, and
 *      both share the single-flight token refresh in web/auth.js.
 *
 * Branding (GET /settings/branding — readable by any authenticated member)
 * is applied the same way web/admin/main.js does it: displayName as
 * textContent only, accentColor only as a validated #rrggbb custom
 * property. Duplicated here on purpose — web/admin/* stays admin-owned.
 *
 * Every dynamic string reaches the DOM via textContent; no inline script
 * (CSP script-src 'self').
 */
import { getAccessToken, logout } from "./auth.js";
import { apiFetch } from "./api.js";
import {
  brandedTitle,
  isAdminRole,
  safeBranding,
  shellNav,
} from "./shell-model.js";

export const LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="none" stroke="#C9A668" stroke-width="3"/><path d="M20 22l7 22 5-14 5 14 7-22" fill="none" stroke="#E7D0A2" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** End the session everywhere this browser knows about, then go to login. */
export async function signOut() {
  await logout();
  location.replace("/index.html");
}

/** Company branding, or null on any failure (the shipped look stays). */
export async function loadBranding() {
  try {
    const res = await apiFetch("/settings/branding");
    if (!res.ok) return null;
    return safeBranding(await res.json());
  } catch {
    return null;
  }
}

/**
 * Personalize the page with the saved branding. Brand text nodes are
 * `[data-brand-name]`; static-header pages keep their footer markup, so the
 * footer's leading brand element is swapped in place too.
 */
export function applyBranding(raw) {
  const branding = safeBranding(raw);
  if (!branding) return;
  const nodes = document.querySelectorAll(
    "[data-brand-name], footer.app > b:first-child, footer.app > .gold:first-child",
  );
  for (const node of nodes) node.textContent = branding.displayName;
  const mark = document.getElementById("brandMark");
  if (mark) mark.alt = branding.displayName;
  document.title = brandedTitle(document.title, branding.displayName);
  if (branding.accentColor) {
    const root = document.documentElement.style;
    root.setProperty("--gp-brand-accent", branding.accentColor);
    root.setProperty("--gp-gold-500", branding.accentColor);
  }
}

/** Refresh every account-name slot after a profile edit. */
export function updateAccountName(user) {
  for (const slot of document.querySelectorAll("[data-shell-account]")) {
    fillAccount(slot, user);
  }
}

function fillAccount(slot, user) {
  const sub = user.title || user.email || "";
  if (slot.classList.contains("who")) {
    slot.replaceChildren(
      el("b", null, user.name),
      document.createElement("br"),
      document.createTextNode(sub),
    );
  } else {
    slot.textContent = user.name;
  }
  slot.title = (sub ? sub + " — " : "") + "Tài khoản của tôi";
}

/**
 * Compact header.app bar for gwp.css pages. `current` is a shellNav key
 * ("dashboard" | "canvas" | "coaching" | "admin") or null.
 */
export function renderAppHeader(identity, { current = null } = {}) {
  const me = identity.user;
  const header = el("header", "app");
  const bar = el("div", "bar");

  const img = document.createElement("img");
  img.className = "mark";
  img.src = LOGO;
  img.alt = "";
  const idWrap = el("div");
  const brand = el("div", "brand", "GoWise Partners");
  brand.setAttribute("data-brand-name", "");
  idWrap.append(brand, el("div", "appname", "Performance Follow-up"));

  const nav = el("nav", "sitenav");
  nav.setAttribute("aria-label", "Công cụ");
  for (const item of shellNav(identity.roles ?? [], current)) {
    const a = el("a", null, item.label);
    a.href = item.href;
    if (item.current) a.setAttribute("aria-current", "page");
    nav.append(a);
  }

  const who = el("a", "who");
  who.href = "/account.html";
  who.setAttribute("data-testid", "account-name");
  who.setAttribute("data-shell-account", "");
  if (current === "account") who.setAttribute("aria-current", "page");
  fillAccount(who, me);

  const out = el("a", "out", "Đăng xuất");
  out.href = "#";
  out.id = "btnOut";
  out.addEventListener("click", (e) => {
    e.preventDefault();
    signOut();
  });

  bar.append(img, idWrap, nav, el("div", "spacer"), who, out);
  header.append(bar);
  document.body.prepend(header);
  return header;
}

export function renderAppFooter(note) {
  const footer = el("footer", "app");
  const brand = el("b", null, "GoWise Partners");
  brand.setAttribute("data-brand-name", "");
  footer.append(
    brand,
    document.createTextNode(
      " · " +
        (note ??
          "Performance Architecture Canvas schema 3.0 — dữ liệu trên bản canvas đã chốt, trong phạm vi bạn được xem."),
    ),
  );
  document.body.append(footer);
  return footer;
}

/* ---------- Self-mount for static hero headers ---------- */

async function mountStaticShell(nav) {
  try {
    await getAccessToken();
  } catch {
    return; // no session — the page's own requireAuth() redirects
  }
  let identity;
  try {
    const res = await apiFetch("/auth/me");
    if (!res.ok) return;
    identity = await res.json();
  } catch {
    return;
  }
  const admin = nav.querySelector("[data-shell-admin]");
  if (admin) admin.hidden = !isAdminRole(identity.roles ?? []);
  const account = nav.querySelector("[data-shell-account]");
  if (account) {
    fillAccount(account, identity.user);
    account.hidden = false;
  }
  const out = nav.querySelector("[data-shell-logout]");
  if (out) {
    out.addEventListener("click", (e) => {
      e.preventDefault();
      signOut();
    });
    out.hidden = false;
  }
  applyBranding(await loadBranding());
}

const staticNav =
  typeof document !== "undefined"
    ? document.querySelector("[data-shell-nav]")
    : null;
if (staticNav) mountStaticShell(staticNav);
