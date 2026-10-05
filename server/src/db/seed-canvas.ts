import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { fromLegacy } from "../../../shared/canvas/legacy.js";
import {
  CANVAS_PAYLOAD_VERSION,
  CanvasBodySchema,
  type CanvasBody,
} from "../../../shared/canvas/schema.js";
import {
  insertCanvas,
  insertVersion,
  setCanvasCurrentVersion,
} from "../modules/canvas/repository.js";
import { DEMO_CANVASES } from "./demo-canvas-data.js";
import { DEMO_IDENTITIES, type DemoId } from "./demo-identities.js";

/**
 * Demo canvas seed (task 2.6, spec §5.1/§5.3). Called inside seedDemo's
 * transaction on demo deployments only.
 *
 * Rules:
 *  - Each legacy canvas becomes one canvas owned by its personId's demo
 *    user; every FULL version passes through the real fromLegacy adapter
 *    and becomes an immutable published snapshot, oldest first.
 *  - brief:true versions are NOT snapshots — they are skipped and their
 *    labels recorded in each imported version's provenance as migration
 *    notes (no fabricated history, no silent drops).
 *  - published_at is pinned to the legacy version date — the seed is a
 *    migration of historical evidence, not fresh activity.
 *  - ENRICH adds authored structured fields the legacy bundle lacked
 *    (assignee_user_id, measurement extension). These are hand-written
 *    fixture facts keyed by legacyId + row index — never name-matched,
 *    never parsed out of prose.
 *  - assignee ids come from the demo identity table, so attention items
 *    resolve to real users the demo dashboard can attribute.
 */

/** Author structured fields onto an adapted body, by row index. */
const ENRICH: Record<
  string,
  {
    /** actions[i].assignee_user_id = DemoId's user id. */
    actionAssignees?: Record<number, DemoId>;
    /** observed[i].measurement = authored typed measurement. */
    measurements?: Record<
      number,
      {
        metricId: string;
        definitionRevision: number;
        layer: "BEHAVIOR" | "OUTPUT" | "RESULT";
        value: number;
        unit: string;
        baseline: number;
        target: number;
      }
    >;
  }
> = {
  tc1: {
    // "own" labels in data.js: Trưởng PGD = p7, Giám đốc vùng = l1.
    actionAssignees: { 0: "p7", 1: "l1", 2: "p7" },
  },
  tc2: {
    measurements: {
      // OUTPUT observed row: "Tỷ lệ cuộc gọi đạt chuẩn tăng từ 65% lên
      // 78%" vs plan target ≥75% — the numbers are real evidence in the
      // source record, authored here as typed measurement.
      2: {
        metricId: "dec50000-0000-4000-8000-0000000000a1",
        definitionRevision: 1,
        layer: "OUTPUT",
        value: 78,
        unit: "%",
        baseline: 65,
        target: 75,
      },
    },
  },
};

interface LegacyVersionStub {
  v?: string;
  week?: string;
  date?: string;
  brief?: boolean;
  change?: string;
  [k: string]: unknown;
}

export interface CanvasSeedReport {
  canvases: number;
  versions: number;
  /** "<legacyId>:<v>" of brief versions that became notes, not rows. */
  skippedBriefs: string[];
  /** Adapter warnings — surfaced so a drifted fixture can't hide. */
  warnings: string[];
}

export async function seedDemoCanvases(
  tx: Knex.Transaction,
  companyId: string,
): Promise<CanvasSeedReport> {
  const report: CanvasSeedReport = {
    canvases: 0,
    versions: 0,
    skippedBriefs: [],
    warnings: [],
  };

  // Resolve demo user ids once — the seed runs inside seedDemo's tx, so
  // the identity rows inserted earlier in the same transaction are
  // visible here.
  const demoUserIds = new Set(
    Object.values(DEMO_IDENTITIES).map((i) => i.demoUserId),
  );
  const existing = new Set(
    (
      await tx("app_user")
        .where({ company_id: companyId })
        .whereIn("id", [...demoUserIds])
        .select("id")
    ).map((r: { id: string }) => r.id),
  );

  for (const [legacyId, canvas] of Object.entries(DEMO_CANVASES)) {
    const ownerId = DEMO_IDENTITIES[canvas.personId as DemoId]?.demoUserId;
    if (!ownerId || !existing.has(ownerId)) {
      report.warnings.push(
        `${legacyId}: demo user "${canvas.personId}" missing — canvas skipped`,
      );
      continue;
    }

    const versions = canvas.versions as LegacyVersionStub[];
    const skipped = versions
      .filter((v) => v.brief === true)
      .map((v) => v.v ?? "?");
    report.skippedBriefs.push(...skipped.map((s) => `${legacyId}:${s}`));

    const canvasRow = await insertCanvas(tx, {
      company_id: companyId,
      owner_user_id: ownerId,
      name: canvas.name,
      created_by: ownerId,
    });
    report.canvases += 1;

    // Oldest first — versions[] arrives newest-first.
    let versionNo = 0;
    let lastVersionId: string | null = null;
    for (const v of [...versions].reverse()) {
      if (v.brief === true) continue;
      const { body, warnings } = fromLegacy(v);
      report.warnings.push(
        ...warnings.map((w) => `${legacyId}:${v.v ?? "?"}: ${w}`),
      );
      if (!body) continue; // adapter refused — warning already recorded

      // Authored structured enrichment, by stable row index.
      const enrich = ENRICH[legacyId];
      if (enrich?.actionAssignees) {
        for (const [idx, demoId] of Object.entries(enrich.actionAssignees)) {
          const a = body.actions[Number(idx)];
          const uid = DEMO_IDENTITIES[demoId].demoUserId;
          if (a && existing.has(uid)) a.assignee_user_id = uid;
        }
      }
      if (enrich?.measurements) {
        for (const [idx, m] of Object.entries(enrich.measurements)) {
          const row = body.observed[Number(idx)];
          if (row) row.measurement = { ...m, date: row.date };
        }
      }

      const ver = await insertVersion(tx, {
        company_id: companyId,
        canvas_id: canvasRow.id,
        version_no: ++versionNo,
        schema_version: CANVAS_PAYLOAD_VERSION,
        body,
        change_summary: v.change ?? null,
        provenance: {
          source: "demo-seed",
          legacyCanvas: legacyId,
          legacyVersion: v.v ?? null,
          week: v.week ?? null,
          date: v.date ?? null,
          skippedBriefs: skipped,
        },
        published_by: ownerId,
        published_at: v.date ? `${v.date}T00:00:00Z` : undefined,
      });
      report.versions += 1;
      lastVersionId = ver.id;
    }

    if (lastVersionId) {
      await setCanvasCurrentVersion(
        tx,
        companyId,
        canvasRow.id,
        lastVersionId,
      );
    }
  }

  return report;
}

/**
 * Weekly check-in figures (seed v3). The retired demo drew its 3-layer
 * chart from hand-authored `series` blocks, which seed v2 deliberately
 * dropped (spec §5.3: trends derive from observed[].measurement only).
 * Those weekly figures ARE the demo's evidence story, so v3 records them
 * the spec-compliant way: one new published version per canvas whose
 * observed[] gains one typed-measurement row per (week, layer). The chart
 * is then recomputed from published evidence like any customer canvas.
 *
 * Week → date follows the legacy version cadence (Wednesday check-ins,
 * T29 = 2026-07-15). null figures in the source are simply not observed.
 * tc2 OUTPUT reuses v2's authored metric identity (65 → 75) so its points
 * join that series instead of forking a second OUTPUT line.
 */
type Layer = "BEHAVIOR" | "OUTPUT" | "RESULT";
interface CheckinMetric {
  metricId: string;
  label: string;
  unit: string;
  baseline: number;
  target: number;
  /** Figures by week label; null = not measured that week. */
  values: Partial<Record<"T29" | "T30" | "T31" | "T32" | "T33", number | null>>;
}

const WEEK_DATE = {
  T29: "2026-07-15",
  T30: "2026-07-22",
  T31: "2026-07-29",
  T32: "2026-08-05",
  T33: "2026-08-12",
} as const;

const CHECKIN_PUBLISHED_AT = "2026-08-13T00:00:00Z";

export const DEMO_CHECKINS: Record<
  string,
  { verifier: string; metrics: Partial<Record<Layer, CheckinMetric>> }
> = {
  tc1: {
    verifier: "Giám đốc vùng HCM",
    metrics: {
      BEHAVIOR: {
        metricId: "dec50000-0000-4000-8000-0000000000b1",
        label: "Nhịp phân công 8h30 + nghe lại cuộc gọi",
        unit: "% ngày đạt",
        baseline: 0,
        target: 100,
        values: { T31: 0, T32: 0, T33: 10 },
      },
      OUTPUT: {
        metricId: "dec50000-0000-4000-8000-0000000000b2",
        label: "Khách hết hạn lãi được gọi lại trong 48h",
        unit: "%",
        baseline: 20,
        target: 90,
        values: { T31: 20, T32: 22, T33: 24 },
      },
      RESULT: {
        metricId: "dec50000-0000-4000-8000-0000000000b3",
        label: "Giải ngân trung bình / tháng",
        unit: "tỷ",
        baseline: 2.1,
        target: 2.8,
        values: { T31: 2.1, T32: 2.1, T33: 2.15 },
      },
    },
  },
  tc2: {
    verifier: "Giám đốc vùng HCM",
    metrics: {
      BEHAVIOR: {
        metricId: "dec50000-0000-4000-8000-0000000000a2",
        label: "Chấm QA + role-play đúng lịch",
        unit: "% buổi đạt",
        baseline: 0,
        target: 100,
        values: { T29: 0, T30: 50, T31: 75, T32: 75, T33: 75 },
      },
      OUTPUT: {
        metricId: "dec50000-0000-4000-8000-0000000000a1",
        label: "Cuộc gọi đạt chuẩn chất lượng",
        unit: "%",
        baseline: 65,
        target: 75,
        // T33 (78) is already observed in v2 — not duplicated here.
        values: { T29: 65, T30: 68, T31: 72, T32: 75 },
      },
      RESULT: {
        metricId: "dec50000-0000-4000-8000-0000000000a3",
        label: "Hồ sơ nhóm 2 xử lý xong trong 30 ngày",
        unit: "%",
        baseline: 58,
        target: 70,
        values: { T29: 58, T30: 58, T31: 59, T32: 60, T33: 61 },
      },
    },
  },
  tc3: {
    verifier: "Trưởng phòng Thẩm định",
    metrics: {
      BEHAVIOR: {
        metricId: "dec50000-0000-4000-8000-0000000000c1",
        label: "Review bảng lệch giá sáng thứ 2",
        unit: "% tuần có bảng",
        baseline: 0,
        target: 100,
        values: { T30: 0, T31: 0, T32: 0, T33: 0 },
      },
      RESULT: {
        metricId: "dec50000-0000-4000-8000-0000000000c3",
        label: "Hồ sơ lệch giá > 5% (càng thấp càng tốt)",
        unit: "%",
        baseline: 8,
        target: 3,
        values: { T30: 8, T31: 7.2, T32: 6.5 },
      },
    },
  },
  reg: {
    verifier: "Giám đốc khối",
    metrics: {
      BEHAVIOR: {
        metricId: "dec50000-0000-4000-8000-0000000000d1",
        label: "Phiên 1-1 hằng tuần đủ ghi chú + cam kết",
        unit: "% phiên đủ",
        baseline: 25,
        target: 100,
        values: { T29: 25, T30: 50, T31: 75, T32: 100, T33: 100 },
      },
      OUTPUT: {
        metricId: "dec50000-0000-4000-8000-0000000000d2",
        label: "Canvas bộ phận đạt PILOTING trở lên",
        unit: "%",
        baseline: 25,
        target: 100,
        values: { T29: 25, T30: 25, T31: 25, T32: 25, T33: 25 },
      },
      RESULT: {
        metricId: "dec50000-0000-4000-8000-0000000000d3",
        label: "Canvas cập nhật đúng nhịp tuần",
        unit: "%",
        baseline: 25,
        target: 90,
        values: { T29: 25, T30: 25, T31: 30, T32: 35, T33: 40 },
      },
    },
  },
};

function fmt(n: number): string {
  return String(n).replace(".", ",");
}

/**
 * Seed v3 — publish one weekly check-in version on top of each demo
 * canvas's current version. Keyed by the v2 provenance (legacyCanvas), so
 * it is a no-op for canvases the v2 seed skipped. Idempotency comes from
 * seedDemo's seed_version gate.
 */
export async function seedDemoCheckins(
  tx: Knex.Transaction,
  companyId: string,
): Promise<{ versions: number }> {
  let versions = 0;
  for (const [legacyId, plan] of Object.entries(DEMO_CHECKINS)) {
    const current = await tx("canvas")
      .join("canvas_version", "canvas_version.id", "canvas.current_version_id")
      .where("canvas.company_id", companyId)
      .whereRaw("canvas_version.provenance->>'legacyCanvas' = ?", [legacyId])
      .whereRaw("canvas_version.provenance->>'source' = 'demo-seed'")
      .first(
        "canvas.id as canvas_id",
        "canvas.owner_user_id",
        "canvas_version.body",
        "canvas_version.version_no",
      );
    if (!current) continue;

    const body = structuredClone(current.body) as CanvasBody;
    for (const [layer, m] of Object.entries(plan.metrics) as [
      Layer,
      CheckinMetric,
    ][]) {
      for (const [wk, value] of Object.entries(m.values)) {
        if (value === null || value === undefined) continue;
        const date = WEEK_DATE[wk as keyof typeof WEEK_DATE];
        body.observed.push({
          id: randomUUID(),
          date,
          layer,
          value: `${m.label}: ${fmt(value)} ${m.unit} (${wk})`,
          source: `Check-in tuần ${wk.slice(1)}`,
          confidence: "MEDIUM",
          learning: "",
          decision: "",
          verifier: plan.verifier,
          measurement: {
            metricId: m.metricId,
            definitionRevision: 1,
            layer,
            date,
            value,
            unit: m.unit,
            baseline: m.baseline,
            target: m.target,
          },
        });
      }
    }
    body.observed.sort((a, b) => a.date.localeCompare(b.date));

    const ver = await insertVersion(tx, {
      company_id: companyId,
      canvas_id: current.canvas_id,
      version_no: current.version_no + 1,
      schema_version: CANVAS_PAYLOAD_VERSION,
      body: CanvasBodySchema.parse(body),
      change_summary:
        "Ghi số đo check-in theo tuần cho ba tầng BEHAVIOR → OUTPUT → RESULT.",
      provenance: {
        source: "demo-seed",
        legacyCanvas: legacyId,
        kind: "weekly-checkins",
      },
      published_by: current.owner_user_id,
      published_at: CHECKIN_PUBLISHED_AT,
    });
    await setCanvasCurrentVersion(tx, companyId, current.canvas_id, ver.id);
    versions += 1;
  }
  return { versions };
}
