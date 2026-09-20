import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSeries,
  metricKey,
  progress,
} from "../../shared/canvas/measurement.js";
import type { CanvasBody } from "../../shared/canvas/schema.js";

/**
 * Task 2.6 — measurement series derived from the canonical body
 * (spec §5.3). Series come ONLY from observed[].measurement — the typed
 * extension with metricId/definitionRevision/unit. Text values are never
 * parsed ("2,1 tỷ" stays prose); a metric whose definition revision or
 * unit changed is a separate series, never silently re-joined; duplicate
 * observed row ids contribute once.
 */

const canonical = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as CanvasBody;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const M1 = randomUUID();
const M2 = randomUUID();

function measurement(over: Record<string, unknown> = {}) {
  return {
    metricId: M1,
    definitionRevision: 1,
    layer: "OUTPUT",
    date: "2026-08-05",
    value: 20,
    unit: "%",
    baseline: 20,
    target: 90,
    ...over,
  };
}

function observedRow(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    date: "2026-08-05",
    layer: "OUTPUT",
    value: "văn bản bằng chứng",
    source: "",
    confidence: "",
    learning: "",
    decision: "",
    verifier: "",
    ...over,
  };
}

function bodyWithObserved(observed: unknown[]): CanvasBody {
  const body = clone(canonical);
  body.observed = observed as CanvasBody["observed"];
  return body;
}

describe("metricKey", () => {
  it("is the [metricId, definitionRevision, unit, baseline, target] quintuple — every definition field discriminates", () => {
    const m = {
      metricId: M1,
      definitionRevision: 1,
      unit: "%",
      baseline: 20,
      target: 90,
    };
    expect(metricKey(m)).toBe(JSON.stringify([M1, 1, "%", 20, 90]));
    expect(metricKey(m)).not.toBe(metricKey({ ...m, unit: "ngày" }));
    expect(metricKey(m)).not.toBe(
      metricKey({ ...m, definitionRevision: 2 }),
    );
    expect(metricKey(m)).not.toBe(metricKey({ ...m, metricId: M2 }));
    // A re-baselined metric is a different definition — never joined.
    expect(metricKey(m)).not.toBe(metricKey({ ...m, baseline: 0 }));
    expect(metricKey(m)).not.toBe(metricKey({ ...m, target: 200 }));
  });
});

describe("progress", () => {
  it("is (value-baseline)/(target-baseline) — 50% mid-way", () => {
    expect(progress(55, 20, 90)).toBeCloseTo(50);
  });

  it("handles lower-is-better targets without special-casing", () => {
    // Giảm lệch giá: baseline 8% → target 3%; hiện tại 5.5% ≈ 50%.
    expect(progress(5.5, 8, 3)).toBeCloseTo(50);
  });

  it("returns null when target === baseline instead of dividing by zero", () => {
    expect(progress(10, 5, 5)).toBeNull();
  });
});

describe("buildSeries", () => {
  it("returns [] when no observed row carries a measurement extension", () => {
    expect(buildSeries(canonical)).toEqual([]);
    expect(buildSeries(bodyWithObserved([observedRow()]))).toEqual([]);
  });

  it("groups points by metric triple and sorts them by measurement date", () => {
    const body = bodyWithObserved([
      observedRow({ measurement: measurement({ date: "2026-08-19", value: 40 }) }),
      observedRow({ measurement: measurement({ date: "2026-08-05", value: 20 }) }),
      observedRow({ measurement: measurement({ date: "2026-08-12", value: 30 }) }),
    ]);
    const [s] = buildSeries(body);
    expect(s.metricId).toBe(M1);
    expect(s.unit).toBe("%");
    expect(s.points.map((p) => p.value)).toEqual([20, 30, 40]);
    expect(s.latest).toBe(40);
    expect(s.progressPct).toBeCloseTo(((40 - 20) / (90 - 20)) * 100);
  });

  it("deduplicates by observed row id — a repeated row contributes once", () => {
    const row = observedRow({ measurement: measurement({ value: 20 }) });
    const body = bodyWithObserved([row, clone(row)]);
    const [s] = buildSeries(body);
    expect(s.points).toHaveLength(1);
  });

  it("splits a changed unit into a separate series — never joins units", () => {
    const body = bodyWithObserved([
      observedRow({ measurement: measurement({ value: 20, unit: "%" }) }),
      observedRow({
        measurement: measurement({ value: 2.1, unit: "tỷ" }),
      }),
    ]);
    const series = buildSeries(body);
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.unit).sort()).toEqual(["%", "tỷ"]);
  });

  it("splits a bumped definitionRevision into a separate series", () => {
    const body = bodyWithObserved([
      observedRow({ measurement: measurement({ definitionRevision: 1 }) }),
      observedRow({
        measurement: measurement({ definitionRevision: 2, date: "2026-08-12" }),
      }),
    ]);
    const series = buildSeries(body);
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.definitionRevision).sort()).toEqual([1, 2]);
  });

  it("keeps different metricIds apart even with the same unit", () => {
    const body = bodyWithObserved([
      observedRow({ measurement: measurement({ metricId: M1 }) }),
      observedRow({ measurement: measurement({ metricId: M2, value: 5 }) }),
    ]);
    expect(buildSeries(body)).toHaveLength(2);
  });

  it("never parses numbers out of text — a value-only row adds no series", () => {
    const body = bodyWithObserved([
      observedRow({ value: "2,1 tỷ — tăng mạnh" }),
    ]);
    expect(buildSeries(body)).toEqual([]);
  });

  it("takes baseline/target from the series' own first point", () => {
    const body = bodyWithObserved([
      observedRow({
        measurement: measurement({ date: "2026-08-05", value: 60, baseline: 58, target: 70 }),
      }),
      observedRow({
        measurement: measurement({ date: "2026-08-12", value: 66, baseline: 58, target: 70 }),
      }),
    ]);
    const [s] = buildSeries(body);
    expect(s.baseline).toBe(58);
    expect(s.target).toBe(70);
    expect(s.progressPct).toBeCloseTo(((66 - 58) / (70 - 58)) * 100);
  });

  it("a re-baselined metric splits into a second series — a point is never scored on foreign endpoints", () => {
    // Gate-review repro: (baseline,target) (0,100) then (100,200) on the
    // same metric — the 150 must read 50%, not 150%.
    const body = bodyWithObserved([
      observedRow({
        measurement: measurement({ date: "2026-08-05", value: 50, baseline: 0, target: 100 }),
      }),
      observedRow({
        measurement: measurement({ date: "2026-08-12", value: 150, baseline: 100, target: 200 }),
      }),
    ]);
    const series = buildSeries(body);
    expect(series).toHaveLength(2);
    const rebased = series.find((s) => s.baseline === 100);
    expect(rebased?.progressPct).toBeCloseTo(50);
    expect(series.find((s) => s.baseline === 0)?.progressPct).toBeCloseTo(50);
  });

  it("keeps the observed row id on each point so the UI can cite evidence", () => {
    const row = observedRow({ measurement: measurement() });
    const [s] = buildSeries(bodyWithObserved([row]));
    expect(s.points[0].observedId).toBe(row.id);
  });
});
