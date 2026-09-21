import { describe, expect, it } from "vitest";
import {
  createPreviewStore,
  PREVIEW_TTL_MS,
} from "../../server/src/modules/ai/preview.js";

/**
 * Preview store (task 3.3, spec §7.3): in-memory only, 15-minute TTL,
 * bounded per-company and process-wide; expired/missing are the same 410.
 */

const BASE = { baseVersionId: null, draftRevision: 1 };

function entry(runId: string, value: unknown, companyId = "c1") {
  return {
    runId,
    actorId: "u1",
    companyId,
    value,
    base: BASE,
  };
}

describe("AI preview store", () => {
  it("serves a fresh preview and answers 410 after the 15-minute TTL", () => {
    let t = 1_000;
    const s = createPreviewStore({ now: () => t });
    s.put(entry("r1", { a: 1 }));
    expect(s.get("r1").value).toEqual({ a: 1 });
    t += PREVIEW_TTL_MS - 1;
    expect(s.get("r1").value).toEqual({ a: 1 });
    t += 2; // past expiry
    expect(() => s.get("r1")).toThrowError(/hết hạn/);
    try {
      s.get("r1");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PREVIEW_EXPIRED");
      expect((e as { status?: number }).status).toBe(410);
    }
  });

  it("410 for a run that never had a preview — same as expired", () => {
    const s = createPreviewStore();
    try {
      s.get("nope");
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PREVIEW_EXPIRED");
      expect((e as { status?: number }).status).toBe(410);
    }
  });

  it("evicts oldest entries when the company byte cap is exceeded", () => {
    // A small entry plus a second that overflows forces eviction of r1.
    const s = createPreviewStore();
    const big = "x".repeat(31 * 1024 * 1024); // ~31 MiB
    s.put(entry("r1", big));
    s.put(entry("r2", { small: true }));
    const bigger = "y".repeat(31 * 1024 * 1024); // forces r1 out to fit
    s.put(entry("r3", bigger));
    expect(() => s.get("r1")).toThrowError(/hết hạn/);
    expect(s.get("r3").value).toBe(bigger);
  });

  it("refuses a single entry larger than the company budget", () => {
    const s = createPreviewStore();
    const huge = "z".repeat(33 * 1024 * 1024);
    try {
      s.put(entry("r1", huge));
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PREVIEW_TOO_LARGE");
      expect((e as { status?: number }).status).toBe(413);
    }
  });

  it("re-putting the same runId replaces the slot", () => {
    const s = createPreviewStore();
    s.put(entry("r1", { v: 1 }));
    s.put(entry("r1", { v: 2 }));
    expect(s.get("r1").value).toEqual({ v: 2 });
  });
});
