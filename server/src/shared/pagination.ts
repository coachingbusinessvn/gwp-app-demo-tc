import { AppError } from "./errors.js";

// Global constraint: pagination defaults to 25, hard-capped at 100.
export function pageLimit(value: unknown): number {
  const n = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100)
    throw new AppError(400, "INVALID_LIMIT", "Giới hạn trang không hợp lệ");
  return n;
}
