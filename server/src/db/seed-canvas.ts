import type { Knex } from "knex";
import { fromLegacy } from "../../../shared/canvas/legacy.js";
import { CANVAS_PAYLOAD_VERSION } from "../../../shared/canvas/schema.js";
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
