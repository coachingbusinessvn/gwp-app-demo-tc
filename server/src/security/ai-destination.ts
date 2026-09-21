import { AppError } from "../shared/errors.js";

/**
 * AI destination validation (spec §7.1): an admin may point the BYOK
 * integration only at operator-allowlisted host:port pairs (env
 * AI_ALLOWED_HOSTS). The allowlist — not an IP-family heuristic — is the
 * whole boundary: private/internal addresses are legitimate BYOK targets
 * when the operator lists them, and public hosts are denied when they are
 * not. This is what stops an admin from aiming the app's outbound AI
 * client at an arbitrary internal or cloud service.
 *
 * Additional invariants enforced here:
 * - http(s) only; http:// requires the explicit AI_ALLOW_HTTP operator
 *   opt-in (trusted networks only — TLS verification is never disabled).
 * - No userinfo — a baseUrl must never carry embedded credentials.
 * - No query string or fragment; the path is kept (e.g. "/v1").
 * - Port must match the allowlist entry exactly: a bare `host` entry
 *   admits only the scheme default port (443/80); `host:port` is exact.
 *   Redirect-following is refused at fetch time by the adapter (task 3.2),
 *   so a validated destination cannot silently hop elsewhere.
 *
 * Allowlist entry grammar: `host`, `host:port`, `[v6]` or `[v6]:port`,
 * case-insensitive, optionally prefixed with a scheme that must match.
 */
export const AI_DESTINATION_DENIED = "AI_DESTINATION_DENIED";
export const AI_HTTP_NOT_ALLOWED = "AI_HTTP_NOT_ALLOWED";

export interface AllowEntry {
  host: string;
  /** null = scheme default port only. */
  port: number | null;
  /** null = either http or https. */
  scheme: "http" | "https" | null;
}

export function parseAllowedHosts(raw: string | undefined): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const piece of (raw ?? "").split(",")) {
    const s = piece.trim();
    if (!s) continue;
    let scheme: AllowEntry["scheme"] = null;
    let rest = s;
    const m = /^(https?):\/\/(.+)$/i.exec(s);
    if (m) {
      scheme = m[1].toLowerCase() as "http" | "https";
      rest = m[2];
    }
    let host: string;
    let port: number | null = null;
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end === -1) throw new Error(`config: bad AI_ALLOWED_HOSTS entry "${s}"`);
      host = rest.slice(1, end).toLowerCase();
      const tail = rest.slice(end + 1);
      if (tail) {
        if (!tail.startsWith(":")) throw new Error(`config: bad AI_ALLOWED_HOSTS entry "${s}"`);
        port = Number(tail.slice(1));
      }
    } else {
      const idx = rest.lastIndexOf(":");
      if (idx === -1) {
        host = rest.toLowerCase();
      } else {
        host = rest.slice(0, idx).toLowerCase();
        port = Number(rest.slice(idx + 1));
      }
    }
    if (!host) throw new Error(`config: bad AI_ALLOWED_HOSTS entry "${s}"`);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error(`config: bad port in AI_ALLOWED_HOSTS entry "${s}"`);
    out.push({ host, port, scheme });
  }
  return out;
}

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

/**
 * Validate and normalize a configured AI baseUrl. Returns the URL as parsed
 * (WHATWG-normalized); callers persist `url.toString().replace(/\/+$/,"")`.
 */
export function validateAiDestination(
  raw: string,
  allowedHosts: AllowEntry[],
  allowHttp: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      400,
      AI_DESTINATION_DENIED,
      "baseUrl không phải URL hợp lệ",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError(
      400,
      AI_DESTINATION_DENIED,
      "baseUrl chỉ cho phép http(s)",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError(
      400,
      AI_DESTINATION_DENIED,
      "baseUrl không được chứa credentials",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new AppError(
      400,
      AI_DESTINATION_DENIED,
      "baseUrl không được chứa query/fragment",
    );
  }
  if (url.protocol === "http:" && !allowHttp) {
    throw new AppError(
      400,
      AI_HTTP_NOT_ALLOWED,
      "baseUrl http:// chỉ dùng được khi operator bật AI_ALLOW_HTTP cho mạng tin cậy",
    );
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port === "" ? defaultPort(url.protocol) : Number(url.port);
  const scheme = url.protocol.slice(0, -1) as "http" | "https";
  const ok = allowedHosts.some(
    (e) =>
      e.host === host &&
      (e.scheme === null || e.scheme === scheme) &&
      (e.port === null ? port === defaultPort(url.protocol) : e.port === port),
  );
  if (!ok) {
    throw new AppError(
      400,
      AI_DESTINATION_DENIED,
      "baseUrl không nằm trong allowlist AI_ALLOWED_HOSTS của deployment",
    );
  }
  return url;
}
