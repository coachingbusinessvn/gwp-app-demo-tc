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
    throw err;
  }
  return data;
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
