import type { CanvasBody, EvidenceLayer } from "./schema.js";

/**
 * Measurement series derived from a canonical body (task 2.6, spec §5.3).
 *
 * A series is NEVER stored — it is recomputed from observed[].measurement
 * (the typed extension carrying metricId/definitionRevision/unit and
 * numeric baseline/target/value). The legacy `value` text is evidence
 * prose and is never parsed for numbers; an observed row without the
 * extension simply contributes no point. Changing a metric's
 * definitionRevision or unit starts a NEW series — points of different
 * definitions are never joined into one trend. Duplicate observed row
 * ids are deduplicated so a repeated import can't double-count.
 */

export interface SeriesPoint {
  /** The observed row this point came from — evidence citation. */
  observedId: string;
  /** ISO date verbatim from measurement.date — never re-zoned. */
  date: string;
  value: number;
  layer: EvidenceLayer;
}

export interface Series {
  /** metricKey() of every point — the series identity. */
  key: string;
  metricId: string;
  definitionRevision: number;
  unit: string;
  /** baseline/target of the series' earliest point — the definition. */
  baseline: number;
  target: number;
  /** Chronological points (measurement.date ascending). */
  points: SeriesPoint[];
  /** Value of the latest point — null only for an empty series (never emitted). */
  latest: number | null;
  /** progress() of the latest point — null when baseline === target. */
  progressPct: number | null;
}

/** Series identity: [metricId, definitionRevision, unit]. */
export function metricKey(m: {
  metricId: string;
  definitionRevision: number;
  unit: string;
}): string {
  return JSON.stringify([m.metricId, m.definitionRevision, m.unit]);
}

/**
 * Percent of the way from baseline to target. Lower-is-better metrics
 * (target < baseline) come out right without special-casing — the sign
 * of the denominator carries the direction. target === baseline is a
 * "maintain" metric: no meaningful percentage, so null.
 */
export function progress(
  value: number,
  baseline: number,
  target: number,
): number | null {
  if (target === baseline) return null;
  return ((value - baseline) / (target - baseline)) * 100;
}

/**
 * All series in one body, one per metric triple. Points sort by the
 * measurement's own ISO date (string compare is correct for YYYY-MM-DD);
 * ties keep observed order. Series appear in first-point order.
 */
export function buildSeries(body: CanvasBody): Series[] {
  const seen = new Set<string>();
  const byKey = new Map<string, Series>();

  const measured = body.observed
    .filter((r) => r.measurement !== undefined)
    .map((r) => ({ row: r, m: r.measurement! }))
    .sort((a, b) => a.m.date.localeCompare(b.m.date));

  for (const { row, m } of measured) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const key = metricKey(m);
    let s = byKey.get(key);
    if (!s) {
      s = {
        key,
        metricId: m.metricId,
        definitionRevision: m.definitionRevision,
        unit: m.unit,
        baseline: m.baseline,
        target: m.target,
        points: [],
        latest: null,
        progressPct: null,
      };
      byKey.set(key, s);
    }
    s.points.push({
      observedId: row.id,
      date: m.date,
      value: m.value,
      layer: m.layer,
    });
  }

  for (const s of byKey.values()) {
    const last = s.points[s.points.length - 1];
    s.latest = last.value;
    s.progressPct = progress(last.value, s.baseline, s.target);
  }
  return [...byKey.values()];
}
