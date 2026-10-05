/* web/account.js — account self-service page (account.html).
 *
 * Any signed-in user, whatever their roles — the admin surface is not
 * needed to fix one's own name or password:
 *   - identity from GET /auth/me (requireAuth — redirects when no session);
 *   - name/title via PATCH /users/:id on the caller's own id. The server
 *     allows self-edit of exactly these two fields (users/service.ts
 *     updateProfile); email, roles and org placement stay owner/admin;
 *   - password via POST /auth/password {currentPassword, newPassword}
 *     (204). Success revokes EVERY session of the caller including this
 *     one (spec §8), so the page clears the local session (logout() also
 *     tells other tabs) and sends the user to the login form with a
 *     "đăng nhập lại" notice — never leaves a dead session on screen.
 *
 * Passwords are only ever read from the inputs into the request body —
 * never logged, stored or echoed back. No inline script (CSP).
 */
import { logout, requireAuth } from "./auth.js";
import { apiFetch } from "./api.js";
import {
  applyBranding,
  loadBranding,
  renderAppFooter,
  renderAppHeader,
  updateAccountName,
} from "./shell.js";
import { passwordChangeError, profilePatch } from "./shell-model.js";

const $ = (id) => document.getElementById(id);

const ROLE_LABEL = {
  owner: "Owner",
  admin: "Quản trị",
  manager: "Quản lý",
  member: "Thành viên",
};

const NETWORK_ERROR = "Không kết nối được máy chủ — thử lại sau.";

/** Server error envelope message, or a fallback. */
async function errorOf(res, fallback) {
  const body = await res.json().catch(() => null);
  return {
    code: typeof body?.code === "string" ? body.code : "REQUEST_FAILED",
    message: typeof body?.message === "string" ? body.message : fallback,
  };
}

function show(node, text) {
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
}
function hide(...nodes) {
  for (const n of nodes) if (n) n.hidden = true;
}

function wireProfile(me) {
  const form = $("frm-profile");
  const name = $("pf-name");
  const title = $("pf-title");
  const err = $("profileErr");
  const ok = $("profileOk");
  const submit = $("profileSubmit");
  name.value = me.name ?? "";
  title.value = me.title ?? "";

  // Any edit after a save clears the stale "Đã lưu" banner.
  form.addEventListener("input", () => hide(ok));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hide(err, ok);
    const { patch, error } = profilePatch(me, name.value, title.value);
    if (error) {
      show(err, error);
      name.focus();
      return;
    }
    if (!patch) {
      show(ok, "Không có thay đổi nào để lưu.");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Đang lưu…";
    try {
      const res = await apiFetch("/users/" + encodeURIComponent(me.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const saved = await res.json();
        me.name = saved.name;
        me.title = saved.title;
        name.value = saved.name ?? "";
        title.value = saved.title ?? "";
        updateAccountName(me);
        show(ok, "Đã lưu thông tin.");
      } else if (res.status === 401) {
        show(err, "Phiên đăng nhập đã hết — tải lại trang để đăng nhập lại.");
      } else {
        show(err, (await errorOf(res, "Không lưu được — thử lại sau.")).message);
      }
    } catch {
      show(err, NETWORK_ERROR);
    } finally {
      submit.disabled = false;
      submit.textContent = "Lưu thông tin";
    }
  });
}

function wirePassword(me) {
  const form = $("frm-password");
  const current = $("pw-current");
  const next = $("pw-new");
  const confirm = $("pw-confirm");
  const err = $("passwordErr");
  const ok = $("passwordOk");
  const submit = $("passwordSubmit");
  const username = $("pw-username");
  if (username) username.value = me.email ?? "";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hide(err, ok);
    const problem = passwordChangeError(current.value, next.value, confirm.value);
    if (problem) {
      show(err, problem);
      (current.value ? next : current).focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Đang đổi…";
    let res;
    try {
      res = await apiFetch("/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: current.value,
          newPassword: next.value,
        }),
      });
    } catch {
      show(err, NETWORK_ERROR);
      submit.disabled = false;
      submit.textContent = "Đổi mật khẩu";
      return;
    }

    if (res.status === 204) {
      // Every session — this one included — is already revoked server-side.
      current.value = "";
      next.value = "";
      confirm.value = "";
      $("passwordFields").disabled = true;
      $("profileFields").disabled = true;
      show(ok, "Đã đổi mật khẩu. Đang chuyển tới trang đăng nhập…");
      // Clears the (now dead) cookies + in-memory token and tells other
      // tabs; best-effort, the redirect happens either way.
      await logout();
      location.replace("/index.html?reason=password-changed");
      return;
    }

    const { code, message } = await errorOf(
      res,
      "Không đổi được mật khẩu — thử lại sau.",
    );
    if (code === "INVALID_CREDENTIALS") {
      show(err, "Mật khẩu hiện tại không đúng.");
      current.value = "";
      current.focus();
    } else if (res.status === 401) {
      show(err, "Phiên đăng nhập đã hết — tải lại trang để đăng nhập lại.");
    } else {
      show(err, message);
    }
    submit.disabled = false;
    submit.textContent = "Đổi mật khẩu";
  });
}

async function init() {
  const identity = await requireAuth(); // null → redirected to index.html
  if (!identity) return;
  const me = { ...identity.user };
  const roles = Array.isArray(identity.roles) ? identity.roles : [];
  renderAppHeader(identity, { current: "account" });
  loadBranding().then(applyBranding);

  $("acctEmail").textContent = me.email ?? "—";
  $("acctRoles").textContent =
    roles.map((r) => ROLE_LABEL[r] ?? r).join(", ") || "—";
  wireProfile(me);
  wirePassword(me);
  $("profileFields").disabled = false;
  $("passwordFields").disabled = false;
  $("acctLoading").hidden = true;
  renderAppFooter("Tài khoản của bạn — mật khẩu chỉ lưu dưới dạng băm, không ai đọc được.");
}

init();
