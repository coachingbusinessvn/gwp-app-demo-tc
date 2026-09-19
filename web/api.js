/* web/api.js — shared API contract (task 0.5, roadmap "Hợp đồng chia sẻ").
 *
 * apiFetch(path, init?):
 *   - path must start with "/" — absolute/protocol-relative URLs are
 *     rejected so a bearer token can never be aimed at another host;
 *   - "/api/v1" is prepended exactly once (paths already carrying it pass
 *     through unchanged);
 *   - attaches the in-memory Bearer token, the X-CSRF-Token double-submit
 *     header on non-GET/HEAD requests, and credentials:"include";
 *   - on 401 performs ONE single-flight refresh and retries exactly once.
 */
import { getAccessToken, readCsrfCookie, refreshAccessToken } from "./auth.js";

const API_PREFIX = "/api/v1";

function resolveUrl(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  ) {
    throw new TypeError(
      'apiFetch: path phải bắt đầu bằng "/" và không được là URL tuyệt đối',
    );
  }
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)
    ? path
    : `${API_PREFIX}${path}`;
}

function buildHeaders(init, token) {
  const headers = new Headers(init.headers ?? undefined);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const method = String(init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCsrfCookie();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  return headers;
}

export async function apiFetch(path, init = {}) {
  const url = resolveUrl(path);
  const token = await getAccessToken().catch(() => null);
  let res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: buildHeaders(init, token),
  });
  if (res.status !== 401) return res;

  // Stale/expired access token — one cross-tab single-flight refresh, then
  // exactly one retry. A failed refresh means the session is gone; the
  // original 401 goes back to the caller untouched.
  const fresh = await refreshAccessToken(token).catch(() => null);
  if (!fresh || fresh === token) return res;
  res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: buildHeaders(init, fresh),
  });
  return res;
}
