/* web/auth.js — real web session (task 0.5, spec §8).
 *
 * The access token lives in module memory ONLY — never localStorage, never
 * disk. The refresh token never leaves the HttpOnly `gwp_refresh` cookie;
 * rotation is coordinated across tabs so a loser tab never presents a
 * consumed token (reuse detection would revoke the whole family):
 *   - `navigator.locks` serializes refresh attempts across tabs of this
 *     origin (lock name embeds the origin for self-documentation — Web Locks
 *     are already origin-scoped),
 *   - `BroadcastChannel` shares the fresh in-memory token to other tabs so
 *     they can skip refreshing entirely,
 *   - inside the lock we re-check the shared token before touching the
 *     rotating cookie.
 * Browsers without Web Locks get a "browser not supported" notice — we do
 * NOT fall back to persisting tokens.
 */
import { apiFetch } from "./api.js";

const API_PREFIX = "/api/v1";
const CSRF_COOKIE = "gwp_csrf";
const LOCK_NAME = `gwp.auth.refresh.${location.origin}`;
const CHANNEL_NAME = `gwp.auth.${location.origin}`;

let accessToken = null;

const channel =
  "BroadcastChannel" in globalThis ? new BroadcastChannel(CHANNEL_NAME) : null;
channel?.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "token" && typeof msg.token === "string") {
    accessToken = msg.token;
  } else if (msg && msg.type === "logout") {
    accessToken = null;
  }
});

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export class UnsupportedBrowserError extends Error {
  constructor() {
    super("Trình duyệt không được hỗ trợ");
    this.name = "UnsupportedBrowserError";
  }
}

/** JS-readable double-submit CSRF cookie value (mirrored to X-CSRF-Token). */
export function readCsrfCookie() {
  const prefix = `${CSRF_COOKIE}=`;
  for (const part of document.cookie.split(";")) {
    const p = part.trim();
    if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length));
  }
  return null;
}

function supportsWebLocks() {
  return (
    typeof navigator !== "undefined" &&
    navigator.locks != null &&
    typeof navigator.locks.request === "function"
  );
}

let noticeShown = false;
/** Persistent, in-page "browser not supported" notice — shown once. */
export function showUnsupportedNotice() {
  if (noticeShown || typeof document === "undefined" || !document.body) return;
  noticeShown = true;
  const el = document.createElement("div");
  el.className = "card browser-unsupported";
  el.setAttribute("role", "alert");
  el.innerHTML =
    '<b>Trình duyệt này không được hỗ trợ.</b> ' +
    "Ứng dụng cần Web Locks (navigator.locks) để giữ phiên đăng nhập an toàn " +
    "giữa các tab. Vui lòng dùng bản Chrome, Edge, Firefox hoặc Safari mới. " +
    "Phiên đăng nhập không được lưu xuống máy.";
  document.body.prepend(el);
}

function assertSupported() {
  if (!supportsWebLocks()) {
    showUnsupportedNotice();
    throw new UnsupportedBrowserError();
  }
}

async function readError(res, fallback) {
  const body = await res.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code : "REQUEST_FAILED";
  const message = typeof body?.message === "string" ? body.message : fallback;
  return new AuthError(res.status, code, message);
}

/**
 * POST /api/v1/auth/login. Resolves the parsed {accessToken, user} on
 * success; rejects with AuthError carrying the server's real error envelope
 * (401 INVALID_CREDENTIALS → "Email hoặc mật khẩu không đúng"). Cookies are
 * set by the server via Set-Cookie on this same-origin credentialed request.
 */
export async function login(email, password) {
  const res = await fetch(`${API_PREFIX}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw await readError(res, "Đăng nhập thất bại — thử lại sau");
  }
  const data = await res.json();
  accessToken = data.accessToken;
  channel?.postMessage({ type: "token", token: accessToken });
  return data;
}

/**
 * Single-flight rotating refresh. `staleToken` is the token the caller just
 * saw fail (or null when there was no token at all): if another tab already
 * rotated and shared a different token while we queued on the lock, we reuse
 * it instead of presenting a now-consumed refresh token.
 */
export function refreshAccessToken(staleToken = null) {
  assertSupported();
  return navigator.locks.request(LOCK_NAME, async () => {
    // Yield once so a queued BroadcastChannel message from the tab that held
    // the lock before us is delivered before we consult the shared token.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (accessToken && accessToken !== staleToken) return accessToken;
    const headers = {};
    const csrf = readCsrfCookie();
    if (csrf) headers["X-CSRF-Token"] = csrf;
    const res = await fetch(`${API_PREFIX}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers,
    });
    if (!res.ok) {
      accessToken = null;
      throw await readError(res, "Phiên không hợp lệ");
    }
    const data = await res.json();
    accessToken = data.accessToken;
    channel?.postMessage({ type: "token", token: accessToken });
    return accessToken;
  });
}

/**
 * Current in-memory access token, or a single-flight refresh when empty.
 * Rejects with AuthError(401) when there is no live session, and with
 * UnsupportedBrowserError when Web Locks are missing.
 */
export function getAccessToken() {
  if (accessToken) return Promise.resolve(accessToken);
  return refreshAccessToken(null);
}

/**
 * POST /api/v1/auth/logout with the double-submit CSRF header; clears the
 * in-memory token and tells other tabs. Best-effort — the server also
 * clears both cookies, so a failed call still ends the local session view.
 */
export async function logout() {
  const headers = {};
  const csrf = readCsrfCookie();
  if (csrf) headers["X-CSRF-Token"] = csrf;
  try {
    await fetch(`${API_PREFIX}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers,
    });
  } catch {
    // Network failure on logout is non-fatal: cookies expire server-side.
  }
  accessToken = null;
  channel?.postMessage({ type: "logout" });
}

/**
 * Async identity gate for account-shell pages: resolves the /me payload
 * `{ user, roles }` on a live session; redirects to /index.html when
 * unauthenticated (after one refresh retry inside apiFetch) and resolves
 * null. Unsupported browsers get the notice instead of a redirect loop.
 */
export async function requireAuth() {
  try {
    await getAccessToken();
    const res = await apiFetch("/auth/me");
    if (!res.ok) throw await readError(res, "Phiên không hợp lệ");
    return await res.json();
  } catch (err) {
    if (err instanceof UnsupportedBrowserError) return null;
    location.replace("/index.html");
    return null;
  }
}

/* ---------- Login page wiring (index.html loads this module) ---------- */

const loginForm = document.getElementById("frm-login");
if (loginForm instanceof HTMLFormElement) {
  if (!supportsWebLocks()) {
    showUnsupportedNotice();
  } else {
    // Existing live session → straight to the shell.
    getAccessToken()
      .then(() => location.replace("dashboard.html"))
      .catch(() => {});
  }
  const errBox = document.getElementById("loginErr");
  const showError = (msg) => {
    if (errBox) {
      errBox.textContent = msg;
      errBox.hidden = false;
    }
  };
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = loginForm.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    if (errBox) errBox.hidden = true;
    try {
      if (!supportsWebLocks()) throw new UnsupportedBrowserError();
      await login(
        loginForm.elements.email.value,
        loginForm.elements.password.value,
      );
      location.replace("dashboard.html");
    } catch (err) {
      if (err instanceof UnsupportedBrowserError) {
        showUnsupportedNotice();
      } else if (err instanceof AuthError) {
        showError(err.message);
      } else {
        showError("Không kết nối được máy chủ — thử lại sau.");
      }
      if (btn) btn.disabled = false;
    }
  });
}
