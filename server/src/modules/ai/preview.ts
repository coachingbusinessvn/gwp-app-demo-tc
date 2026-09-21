import { AppError } from "../../shared/errors.js";

/**
 * Ephemeral AI result previews (task 3.3, spec §7.3): a proposal lives in
 * PROCESS MEMORY ONLY for 15 minutes — never in the database, never in a
 * log. After TTL or a restart the client gets an explicit 410 and must run
 * again; we never pretend a lost preview can be resumed.
 *
 * Bounds (single-process pilot):
 * - 32 MiB total per company, 128 MiB process-wide.
 * - A put that would overflow evicts the oldest entries first; one entry
 *   larger than the company budget is refused outright.
 * - Ownership is enforced by the runs service (only the run's creator may
 *   read its preview) — this store just holds bytes with a TTL.
 */

export const PREVIEW_TTL_MS = 15 * 60 * 1000;
export const PREVIEW_COMPANY_BYTES = 32 * 1024 * 1024;
export const PREVIEW_PROCESS_BYTES = 128 * 1024 * 1024;

export const PREVIEW_EXPIRED = "PREVIEW_EXPIRED";
export const PREVIEW_TOO_LARGE = "PREVIEW_TOO_LARGE";
export const AI_PREVIEW_BUSY = "AI_PREVIEW_BUSY";

export interface PreviewEntry {
  runId: string;
  actorId: string;
  companyId: string;
  /** The opaque proposal payload (validated renderer output, coach JSON). */
  value: unknown;
  /** Canvas base captured at run start — apply compares against this. */
  base: { baseVersionId: string | null; draftRevision: number | null };
  bytes: number;
  createdAt: number;
  expiresAt: number;
}

interface StoreDeps {
  now?: () => number;
}

export function createPreviewStore({ now }: StoreDeps = {}) {
  const nowFn = now ?? (() => Date.now());
  const entries = new Map<string, PreviewEntry>();
  const companyBytes = new Map<string, number>();
  let processBytes = 0;

  function expired(e: PreviewEntry): boolean {
    return nowFn() >= e.expiresAt;
  }

  function drop(runId: string): void {
    const e = entries.get(runId);
    if (!e) return;
    entries.delete(runId);
    processBytes -= e.bytes;
    companyBytes.set(
      e.companyId,
      (companyBytes.get(e.companyId) ?? 0) - e.bytes,
    );
  }

  function sweepExpired(): void {
    for (const e of [...entries.values()]) if (expired(e)) drop(e.runId);
  }

  function evictOldest(neededFor: { companyId: string; bytes: number }): void {
    const oldestFirst = [...entries.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    for (const e of oldestFirst) {
      const fits =
        processBytes + neededFor.bytes <= PREVIEW_PROCESS_BYTES &&
        (companyBytes.get(neededFor.companyId) ?? 0) + neededFor.bytes <=
          PREVIEW_COMPANY_BYTES;
      if (fits) return;
      drop(e.runId);
    }
  }

  function put(preview: {
    runId: string;
    actorId: string;
    companyId: string;
    value: unknown;
    base: { baseVersionId: string | null; draftRevision: number | null };
  }): void {
    const bytes = Buffer.byteLength(JSON.stringify(preview.value), "utf8");
    if (bytes > PREVIEW_COMPANY_BYTES || bytes > PREVIEW_PROCESS_BYTES) {
      throw new AppError(
        413,
        PREVIEW_TOO_LARGE,
        "Kết quả AI vượt giới hạn preview",
      );
    }
    drop(preview.runId); // replace semantics — same run rewrites its slot
    sweepExpired();
    evictOldest({ companyId: preview.companyId, bytes });
    const stillOver =
      processBytes + bytes > PREVIEW_PROCESS_BYTES ||
      (companyBytes.get(preview.companyId) ?? 0) + bytes >
        PREVIEW_COMPANY_BYTES;
    if (stillOver) {
      throw new AppError(
        429,
        AI_PREVIEW_BUSY,
        "Preview đang đầy — thử lại sau",
      );
    }
    const t = nowFn();
    entries.set(preview.runId, {
      runId: preview.runId,
      actorId: preview.actorId,
      companyId: preview.companyId,
      value: preview.value,
      base: preview.base,
      bytes,
      createdAt: t,
      expiresAt: t + PREVIEW_TTL_MS,
    });
    processBytes += bytes;
    companyBytes.set(
      preview.companyId,
      (companyBytes.get(preview.companyId) ?? 0) + bytes,
    );
  }

  /**
   * Get a preview. Missing AND expired both answer 410 PREVIEW_EXPIRED —
   * spec: an expired/restart-lost preview reports "run again", never a
   * distinction that leaks which previews ever existed.
   */
  function get(runId: string): PreviewEntry {
    const e = entries.get(runId);
    if (!e || expired(e)) {
      if (e) drop(runId);
      throw new AppError(
        410,
        PREVIEW_EXPIRED,
        "Preview đã hết hạn — hãy chạy AI lại",
      );
    }
    return e;
  }

  return { put, get };
}

export type PreviewStore = ReturnType<typeof createPreviewStore>;
