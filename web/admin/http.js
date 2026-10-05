/* web/admin/http.js — shared helpers for the admin modules (task 1.5).
 * Dependency-free, same style as web/auth.js. Every dynamic string reaches
 * the DOM via textContent/createTextNode — never innerHTML with data.
 */
import { apiFetch } from "../api.js";

/**
 * JSON API call through the real apiFetch (Bearer in memory + CSRF
 * double-submit + one-flight refresh). Resolves the parsed body (null on
 * 204); rejects with an Error carrying .code/.status from the server's
 * error envelope.
 */
export async function reqJson(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await apiFetch(path, init);
  const data =
    res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(
      typeof data?.message === "string"
        ? data.message
        : "Yêu cầu thất bại — thử lại sau",
    );
    err.code = typeof data?.code === "string" ? data.code : "REQUEST_FAILED";
    err.status = res.status;
    // INVALID_INPUT carries details.fields — forms map them to labels.
    err.fields = Array.isArray(data?.details?.fields)
      ? data.details.fields.filter((f) => typeof f === "string")
      : [];
    throw err;
  }
  return data;
}

/**
 * Every item of a cursor-paginated list ({items, nextCursor}) — the
 * server caps a page at 100, so admin tables must walk the cursor or the
 * tail of a larger org silently disappears. Same contract as web/api.js
 * apiFetchAll (bounded by maxPages), but built on reqJson so a failed page
 * rejects with the server's own message/code rather than a bare status.
 */
export async function reqAll(path, { maxPages = 100 } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const items = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const q = cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : "";
    const body = await reqJson("GET", path + q);
    items.push(...(body?.items ?? []));
    cursor = body?.nextCursor ?? null;
    if (!cursor) break;
  }
  return items;
}

/**
 * Native confirm() for destructive/privileged admin actions — names the
 * subject and the consequence. Kept in one place so tests (Playwright
 * page.on("dialog")) and future UI swaps have a single seam.
 */
export function confirmAction(message) {
  return window.confirm(message);
}

/** A role=status line for non-error outcomes (e.g. "Đã lưu"). */
export function statusLine() {
  const p = el("p", "note");
  p.setAttribute("role", "status");
  p.hidden = true;
  return p;
}

export function showStatus(box, text) {
  if (!box) return;
  box.textContent = text;
  box.hidden = false;
}

/** el("td", "cls", "text") — text always via textContent. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Surface an error (or plain message) into a role=alert box. */
export function showError(box, err) {
  if (!box) return;
  box.textContent =
    err instanceof Error ? err.message : String(err ?? "Lỗi không xác định");
  box.hidden = false;
}

export function clearError(box) {
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
}

/** Labeled input row matching the app's label/field markup. */
export function field(labelText, input) {
  const id = `f-${Math.random().toString(36).slice(2, 10)}`;
  input.id = id;
  const label = el("label", null, labelText);
  label.setAttribute("for", id);
  label.style.display = "block";
  label.style.fontSize = "11.5px";
  label.style.fontWeight = "600";
  label.style.margin = "10px 0 4px";
  const wrap = el("div");
  wrap.append(label, input);
  return wrap;
}

/** A plain text input with admin-page styling (light background). */
export function textInput(attrs = {}) {
  const input = document.createElement("input");
  input.type = "text";
  input.style.width = "100%";
  input.style.padding = "9px 11px";
  input.style.border = "1px solid var(--line)";
  input.style.borderRadius = "var(--gp-radius-sm)";
  input.style.font = "inherit";
  for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
  return input;
}

/** A styled <select>. */
export function selectInput() {
  const s = document.createElement("select");
  s.style.width = "100%";
  s.style.padding = "9px 11px";
  s.style.border = "1px solid var(--line)";
  s.style.borderRadius = "var(--gp-radius-sm)";
  s.style.font = "inherit";
  s.style.background = "var(--gp-white)";
  return s;
}

/** A small secondary button (same visual family as button.mini). */
export function miniButton(label) {
  const b = el("button", "mini", label);
  b.type = "button";
  return b;
}

/** A primary submit button. */
export function submitButton(label) {
  const b = el("button", "btn", label);
  b.type = "submit";
  return b;
}
