/* web/activate.js — one-time credential-token consume page (task 1.5,
 * spec §8).
 *
 * Why the token travels in the URL: the owner issues the token through
 * admin.html and hands the ready-made `activate.html?token=…` link to the
 * user over an internal channel — there is no mail/SMTP in this
 * deployment. The page reads it once from ?token= and immediately scrubs
 * the address bar via history.replaceState so the secret does not linger
 * in history, bookmarks or referers. The token is NEVER written to
 * localStorage, NEVER logged (no console.* of it) and sent nowhere except
 * the consume endpoint below. ?purpose=reset switches the same page to
 * the password-reset flow (/auth/reset instead of /auth/activate).
 *
 * Unauthenticated by design — no session exists yet; consume never sets
 * cookies. On success the user follows the "Đăng nhập" link to index.html
 * and logs in normally.
 */

const params = new URLSearchParams(location.search);
const token = params.get("token") ?? "";
const purpose = params.get("purpose") === "reset" ? "reset" : "activate";

// Scrub the token from the visible URL as early as possible.
history.replaceState(null, "", location.pathname);

const ENDPOINT =
  purpose === "reset" ? "/api/v1/auth/reset" : "/api/v1/auth/activate";

const form = document.getElementById("frm-activate");
const title = document.getElementById("act-title");
const sub = document.getElementById("act-sub");
const errBox = document.getElementById("actErr");
const okBox = document.getElementById("actOk");
const submit = document.getElementById("actSubmit");
const loginLink = document.getElementById("actLogin");
const pw1 = document.getElementById("pw1");
const pw2 = document.getElementById("pw2");

function showError(msg) {
  if (errBox) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }
}

if (purpose === "reset") {
  if (title) title.textContent = "Đặt lại mật khẩu";
  if (sub)
    sub.textContent =
      "Đặt mật khẩu mới cho tài khoản của bạn. Liên kết này chỉ dùng được một lần.";
  if (submit) submit.textContent = "Đặt lại mật khẩu";
  if (okBox)
    okBox.textContent = "Mật khẩu đã đổi — đăng nhập bằng mật khẩu mới.";
}

if (token === "") {
  // A consume link without a token can never succeed — fail closed and
  // say so, instead of letting the user type a password for nothing.
  if (submit) submit.disabled = true;
  showError("Liên kết không hợp lệ — thiếu mã xác thực. Xin lại liên kết từ owner.");
}

if (form instanceof HTMLFormElement) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (errBox) errBox.hidden = true;
    if (pw1.value !== pw2.value) {
      showError("Mật khẩu nhập lại không khớp.");
      return;
    }
    if (submit) submit.disabled = true;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw1.value }),
      });
      if (res.status === 204) {
        // Success: swap the form for the done state — the token is dead
        // now (single-use) and this page keeps no copy.
        pw1.value = "";
        pw2.value = "";
        pw1.disabled = true;
        pw2.disabled = true;
        if (submit) submit.hidden = true;
        if (okBox) okBox.hidden = false;
        if (loginLink) loginLink.hidden = false;
        return;
      }
      const data = await res.json().catch(() => null);
      showError(
        typeof data?.message === "string"
          ? data.message
          : "Không xử lý được — thử lại sau",
      );
      if (submit) submit.disabled = false;
    } catch {
      showError("Không kết nối được máy chủ — thử lại sau.");
      if (submit) submit.disabled = false;
    }
  });
}
