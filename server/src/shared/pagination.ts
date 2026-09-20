import { AppError } from "./errors.js";

// Global constraint: pagination defaults to 25, hard-capped at 100.
export function pageLimit(value: unknown): number {
  const n = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100)
    throw new AppError(400, "INVALID_LIMIT", "Giới hạn trang không hợp lệ");
  return n;
}

const CURSOR_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Capture groups let the calendar check below inspect each component —
// the shape alone is not enough (see the normalization note).
const CURSOR_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface KeysetCursor {
  at: string;
  id: string;
}

/**
 * Composite keyset cursor `<iso-µs>|<uuid>` — the (created_at, id) position
 * of the previous page's last row. Shared by the audit and canvas list
 * routes, which render `at` through Postgres itself at µs precision so the
 * round-trip through ::timestamptz is exact.
 *
 * The calendar-component check is what keeps an impossible date from
 * reaching Postgres: JS Date NORMALIZES out-of-range fields
 * (2026-02-31T00:00:00Z parses "fine" as Mar 3, and 25:00 as next-day
 * 01:00), so Number.isFinite alone cannot catch them — Postgres then
 * rejects the ::timestamptz cast with 22008 and the request would 500.
 * Anything malformed is 400 INVALID_CURSOR.
 */
export function keysetCursorParam(raw: unknown): KeysetCursor | undefined {
  if (raw === undefined) return undefined;
  const s = typeof raw === "string" ? raw : "";
  const sep = s.lastIndexOf("|");
  const at = sep > 0 ? s.slice(0, sep) : "";
  const id = sep > 0 ? s.slice(sep + 1) : "";
  const m = CURSOR_INSTANT_RE.exec(at);
  if (!m || !CURSOR_UUID_RE.test(id)) {
    throw new AppError(400, "INVALID_CURSOR", "Con trỏ trang không hợp lệ");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const tz = m[8];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const realCalendarTime =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (tz === "Z" ||
      (Number(tz.slice(1, 3)) <= 23 && Number(tz.slice(4, 6)) <= 59));
  if (!realCalendarTime || !Number.isFinite(new Date(at).getTime())) {
    throw new AppError(400, "INVALID_CURSOR", "Con trỏ trang không hợp lệ");
  }
  return { at, id };
}
