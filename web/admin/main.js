/* web/admin/main.js — admin page shell (task 1.5).
 *
 * Loads the real session via requireAuth() (Bearer in memory, refresh in
 * the HttpOnly cookie — no localStorage, no demo fallback). The surface is
 * owner/admin only: anyone else is sent back to the account shell, and an
 * unauthenticated visitor is redirected to index.html by requireAuth.
 *
 * Chrome matches the other account-shell pages (header.app / footer.app),
 * built with DOM APIs — dynamic strings only ever reach the page via
 * textContent. Branding is applied as text + a validated #hex CSS custom
 * property value, never as injected HTML/CSS.
 *
 * Loaded as <script type="module"> — no inline scripts (CSP script-src 'self').
 */
import { logout, requireAuth } from "../auth.js";
import { el, reqJson } from "./http.js";
import { mountOrg } from "./org.js";
import { mountUsers } from "./users.js";
import { mountAudit } from "./audit.js";
import { mountAi } from "./ai.js";

const LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="none" stroke="#C9A668" stroke-width="3"/><path d="M20 22l7 22 5-14 5 14 7-22" fill="none" stroke="#E7D0A2" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Personalize the shell with the saved branding. displayName is plain
 * text (textContent only); accentColor must be a #rrggbb value — anything
 * else is ignored rather than applied, so a malformed stored value can
 * never become CSS injection.
 */
function applyBranding(branding) {
  const nameEl = document.getElementById("brand-name");
  if (nameEl) nameEl.textContent = branding.displayName;
  if (HEX_COLOR.test(branding.accentColor)) {
    const root = document.documentElement.style;
    root.setProperty("--gp-brand-accent", branding.accentColor);
    root.setProperty("--gp-gold-500", branding.accentColor);
    const swatch = document.getElementById("brand-accent");
    if (swatch) swatch.style.backgroundColor = branding.accentColor;
  }
}

function renderHeader(me) {
  const header = el("header", "app");
  const bar = el("div", "bar");
  const img = document.createElement("img");
  img.className = "mark";
  img.src = LOGO;
  img.alt = "";
  const idWrap = el("div");
  const brand = el("div", "brand", "GoWise Partners");
  brand.id = "brand-name";
  idWrap.append(brand, el("div", "appname", "Performance Follow-up"));
  const nav = el("nav", "sitenav");
  nav.setAttribute("aria-label", "Công cụ");
  const dash = el("a", null, "Bảng theo dõi");
  dash.href = "dashboard.html";
  const admin = el("a", null, "Quản trị");
  admin.href = "admin.html";
  nav.append(dash, admin);
  const spacer = el("div", "spacer");
  const who = el("div", "who");
  who.setAttribute("data-testid", "account-name");
  who.append(
    el("b", null, me.name),
    document.createElement("br"),
    document.createTextNode(me.title || me.email),
  );
  const out = el("a", "out", "Đăng xuất");
  out.href = "#";
  out.id = "btnOut";
  out.addEventListener("click", async (e) => {
    e.preventDefault();
    await logout();
    location.replace("index.html");
  });
  bar.append(img, idWrap, nav, spacer, who, out);
  header.append(bar);
  document.body.prepend(header);
}

function renderFooter() {
  const footer = el("footer", "app");
  const b = el("b", null, "GoWise Partners");
  footer.append(
    b,
    document.createTextNode(
      " · Performance Architecture Canvas schema 3.0 — Phase 1: quản trị tổ chức.",
    ),
  );
  document.body.append(footer);
}

function wireTabs() {
  const tabs = [
    ["tab-org", "panel-org"],
    ["tab-users", "panel-users"],
    ["tab-audit", "panel-audit"],
    ["tab-ai", "panel-ai"],
  ];
  for (const [tid] of tabs) {
    document.getElementById(tid)?.addEventListener("click", () => {
      for (const [t, p] of tabs) {
        const on = t === tid;
        document.getElementById(t)?.setAttribute("aria-selected", String(on));
        const panel = document.getElementById(p);
        if (panel) panel.hidden = !on;
      }
    });
  }
}

async function init() {
  const identity = await requireAuth(); // { user, roles } — null after redirect
  if (!identity) return;
  const roles = Array.isArray(identity.roles) ? identity.roles : [];
  const isOwner = roles.includes("owner");
  const isAdmin = roles.includes("admin");
  if (!isOwner && !isAdmin) {
    // The admin surface is owner/admin only (spec §4) — everyone else
    // returns to the regular account shell.
    location.replace("dashboard.html");
    return;
  }
  const me = identity.user;
  renderHeader(me);

  const branding = await reqJson("GET", "/settings/branding").catch(
    () => null,
  );
  mountOrg(document.getElementById("panel-org"), {
    branding,
    onBrandingSaved: applyBranding,
  });
  mountUsers(document.getElementById("panel-users"), {
    isOwner,
    selfId: me.id,
  });
  mountAudit(document.getElementById("panel-audit"));
  mountAi(document.getElementById("panel-ai"));
  if (branding) applyBranding(branding);
  renderFooter();
}

// Tabs are wired at module load, not inside init(): module scripts run
// after DOM parsing, while init()'s requireAuth() round-trip leaves a
// window where a visible tab's click would be silently dropped (the
// admin e2e flake — panel stays hidden, "Tạo người dùng" never mounts).
wireTabs();
init();
