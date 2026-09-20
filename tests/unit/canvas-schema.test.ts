import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ACTION_STATUSES,
  CANVAS_STAGES,
  CanvasBodySchema,
  Measurement,
  SIX_BOXES,
  type CanvasBody,
} from "../../shared/canvas/schema.js";
import { blankCanvas } from "../../shared/canvas/defaults.js";
import { fromLegacy } from "../../shared/canvas/legacy.js";
import { validateCanvas, type Issue } from "../../shared/canvas/validation.js";

/**
 * Task 2.1 — canonical canvas payload + legacy adapter (spec §5).
 *
 * canonical.json is the golden canonical body for the legacy.json demo
 * snapshot (assets/data.js CANVAS.tc2 v2, PILOTING with real observed
 * evidence). Row IDs are the only intentional difference between the two —
 * canonical carries stable UUIDs, the legacy record carries none.
 */
const canonical = JSON.parse(
  readFileSync(new URL("../fixtures/canvas/canonical.json", import.meta.url), "utf8"),
) as CanvasBody;
const legacyFull = JSON.parse(
  readFileSync(new URL("../fixtures/canvas/legacy.json", import.meta.url), "utf8"),
) as Record<string, any>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function errors(issues: Issue[]) {
  return issues.filter((i) => i.severity === "error");
}

/** Replace generated ids with positions so two bodies compare structurally. */
function normalizeIds(body: CanvasBody): unknown {
  const b = clone(body) as any;
  const behaviorPos = new Map<string, number>();
  b.behaviors.forEach((r: any, i: number) => {
    behaviorPos.set(r.id, i);
    r.id = `#${i}`;
  });
  b.outputs.forEach((r: any, i: number) => (r.id = `#${i}`));
  b.actions.forEach((r: any, i: number) => (r.id = `#${i}`));
  b.plan.forEach((r: any, i: number) => (r.id = `#${i}`));
  b.observed.forEach((r: any, i: number) => (r.id = `#${i}`));
  b.reviews.forEach((r: any, i: number) => (r.id = `#${i}`));
  b.boxes.forEach((r: any, i: number) => {
    r.id = `#${i}`;
    r.behavior_id =
      r.behavior_id === null ? null : `#${behaviorPos.get(r.behavior_id)}`;
  });
  return b;
}

describe("CanvasBodySchema — full editor field inventory", () => {
  it("accepts the canonical fixture unchanged (round-trip every field)", () => {
    const parsed = CanvasBodySchema.parse(canonical);
    expect(parsed).toEqual(canonical);
  });

  it("blankCanvas(clock) is schema-valid and mirrors blankState()", () => {
    const body = blankCanvas(() => new Date("2026-09-20T08:00:00Z"));
    expect(CanvasBodySchema.safeParse(body).success).toBe(true);
    expect(body.schema_version).toBe(1);
    expect(body.meta).toMatchObject({
      title: "",
      owner: "",
      stage: "DRAFT",
      mode: "GUIDED",
      updated: "2026-09-20",
      schema: "3.0",
    });
    expect(body.outputs).toHaveLength(1);
    expect(body.behaviors).toHaveLength(2);
    expect(body.boxes.map((b) => b.box)).toEqual([...SIX_BOXES]);
    expect(body.plan.map((p) => p.layer)).toEqual([
      "BEHAVIOR",
      "OUTPUT",
      "RESULT",
    ]);
    expect(body.reviews.map((r) => r.checkpoint)).toEqual([
      "Sau 7 ngày",
      "Sau 2–4 tuần",
    ]);
    for (const row of [
      ...body.outputs,
      ...body.behaviors,
      ...body.boxes,
      ...body.actions,
      ...body.plan,
      ...body.observed,
      ...body.reviews,
    ]) {
      expect(row.id).toMatch(UUID_RE);
    }
    expect(body.actions[0]!.status).toBe("Chưa bắt đầu");
  });

  it("rejects invalid enum values instead of silently defaulting", () => {
    for (const stage of ["PILOT", "draft", "Done"]) {
      const bad = clone(canonical);
      bad.meta.stage = stage as never;
      expect(CanvasBodySchema.safeParse(bad).success).toBe(false);
    }
    const badGap = clone(canonical);
    badGap.boxes[0]!.gap = "Khổng lồ" as never;
    expect(CanvasBodySchema.safeParse(badGap).success).toBe(false);
    const badStatus = clone(canonical);
    badStatus.actions[0]!.status = "DONE" as never;
    expect(CanvasBodySchema.safeParse(badStatus).success).toBe(false);
  });

  it("allows empty strings on blankable enum fields but not required ones", () => {
    const body = clone(canonical);
    body.boxes[0]!.gap = "" as never;
    body.boxes[0]!.priority = "" as never;
    body.plan[0]!.layer = "" as never;
    body.observed[0]!.confidence = "" as never;
    body.observed[0]!.decision = "" as never;
    expect(CanvasBodySchema.safeParse(body).success).toBe(true);
    const bad = clone(canonical);
    bad.actions[0]!.status = "" as never;
    bad.meta.stage = "" as never;
    expect(CanvasBodySchema.safeParse(bad).success).toBe(false);
  });

  it("rejects wrong types even though draft permits empty strings", () => {
    const cases: Array<(b: CanvasBody) => void> = [
      (b) => ((b.goal as any).statement = 123),
      (b) => ((b as any).outputs = "x"),
      (b) => ((b.kr as any).current = null),
      (b) => ((b as any).risks = ["a", "b"]),
      (b) => ((b.observed[0] as any).date = "12/08/2026"),
      (b) => ((b.boxes[0] as any).behavior_id = "không-phải-uuid"),
    ];
    for (const mutate of cases) {
      const bad = clone(canonical);
      mutate(bad);
      const issues = validateCanvas(bad, "draft");
      expect(errors(issues).length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown/privilege fields at every level (.strict)", () => {
    expect(
      CanvasBodySchema.safeParse({ ...canonical, company_id: "injected" })
        .success,
    ).toBe(false);
    expect(
      CanvasBodySchema.safeParse({ ...canonical, owner_user_id: "x" }).success,
    ).toBe(false);
    const nested = clone(canonical);
    (nested.meta as any).role = "admin";
    expect(CanvasBodySchema.safeParse(nested).success).toBe(false);
    const rowLevel = clone(canonical);
    (rowLevel.outputs[0] as any).canvas_id = "x";
    expect(CanvasBodySchema.safeParse(rowLevel).success).toBe(false);
    const measure = clone(canonical);
    (measure.observed[0] as any).measurement = { user_id: "injected" };
    expect(CanvasBodySchema.safeParse(measure).success).toBe(false);
  });

  it("bounds lists: outputs ≤3, behaviors ≤5, boxes exactly 6", () => {
    const out4 = clone(canonical);
    out4.outputs = [0, 1, 2, 3].map(() => clone(canonical.outputs[0]!));
    expect(CanvasBodySchema.safeParse(out4).success).toBe(false);
    const beh6 = clone(canonical);
    beh6.behaviors = [0, 1, 2, 3, 4, 5].map(() => clone(canonical.behaviors[0]!));
    expect(CanvasBodySchema.safeParse(beh6).success).toBe(false);
    const box5 = clone(canonical);
    box5.boxes = canonical.boxes.slice(0, 5);
    expect(CanvasBodySchema.safeParse(box5).success).toBe(false);
    const box7 = clone(canonical);
    box7.boxes = [...canonical.boxes, clone(canonical.boxes[0]!)];
    expect(CanvasBodySchema.safeParse(box7).success).toBe(false);
  });
});

describe("validateCanvas — draft vs publish semantics", () => {
  it("accepts the canonical fixture for publish with zero errors", () => {
    expect(errors(validateCanvas(canonical, "publish"))).toEqual([]);
    expect(errors(validateCanvas(canonical, "draft"))).toEqual([]);
  });

  it("draft allows blank content but publish requires it", () => {
    const blank = blankCanvas(() => new Date("2026-09-20T00:00:00Z"));
    expect(errors(validateCanvas(blank, "draft"))).toEqual([]);
    const published = errors(validateCanvas(blank, "publish"));
    expect(published.length).toBeGreaterThan(0);
    expect(published.some((i) => i.path === "goal.statement")).toBe(true);
    expect(published.some((i) => i.path === "meta.title")).toBe(true);
  });

  it("publish enforces 1–3 outputs and 2–5 behaviors", () => {
    const noOut = clone(canonical);
    noOut.outputs = [];
    expect(
      errors(validateCanvas(noOut, "publish")).some((i) => i.path === "outputs"),
    ).toBe(true);
    expect(errors(validateCanvas(noOut, "draft"))).toEqual([]);
    const oneBeh = clone(canonical);
    oneBeh.behaviors = canonical.behaviors.slice(0, 1);
    oneBeh.boxes.forEach((b) => (b.behavior_id = null));
    const issues = errors(validateCanvas(oneBeh, "publish"));
    expect(issues.some((i) => i.path === "behaviors")).toBe(true);
  });

  it("publish requires all six canonical boxes with content", () => {
    const dup = clone(canonical);
    dup.boxes[5]!.box = canonical.boxes[0]!.box;
    const issues = errors(validateCanvas(dup, "publish"));
    expect(issues.some((i) => i.code === "box_set")).toBe(true);
    const noCond = clone(canonical);
    noCond.boxes[2]!.condition = "";
    expect(
      errors(validateCanvas(noCond, "publish")).some(
        (i) => i.path === "boxes.2.condition",
      ),
    ).toBe(true);
  });

  it("flags a dangling boxes[].behavior_id in BOTH modes (missing reference)", () => {
    const bad = clone(canonical);
    bad.boxes[0]!.behavior_id = "550e8400-e29b-41d4-a716-446655440000";
    for (const mode of ["draft", "publish"] as const) {
      const issues = errors(validateCanvas(bad, mode));
      expect(
        issues.some(
          (i) =>
            i.code === "missing_reference" && i.path === "boxes.0.behavior_id",
        ),
      ).toBe(true);
    }
  });

  it("treats behavior_id null as unconfirmed — ok in draft, error at publish", () => {
    const unlinked = clone(canonical);
    unlinked.boxes[0]!.behavior_id = null;
    expect(
      errors(validateCanvas(unlinked, "draft")).filter(
        (i) => i.path === "boxes.0.behavior_id",
      ),
    ).toEqual([]);
    expect(
      errors(validateCanvas(unlinked, "publish")).some(
        (i) => i.path === "boxes.0.behavior_id",
      ),
    ).toBe(true);
  });

  it("VALIDATED publish requires real observed evidence (date/source/verifier/learning/decision)", () => {
    const validated = clone(canonical);
    validated.meta.stage = "VALIDATED";
    // tc2 fixture has 3 fully-populated observed rows — passes.
    expect(errors(validateCanvas(validated, "publish"))).toEqual([]);

    const noObs = clone(validated);
    noObs.observed = [];
    expect(
      errors(validateCanvas(noObs, "publish")).some(
        (i) => i.code === "validated_requires_evidence",
      ),
    ).toBe(true);
    // draft mode never blocks on business completeness
    expect(
      errors(validateCanvas(noObs, "draft")).filter(
        (i) => i.code === "validated_requires_evidence",
      ),
    ).toEqual([]);

    // A blank observed row is NOT evidence.
    const blankObs = clone(validated);
    blankObs.observed = [blankCanvas(() => new Date()).observed[0]!];
    expect(
      errors(validateCanvas(blankObs, "publish")).some(
        (i) => i.code === "validated_requires_evidence",
      ),
    ).toBe(true);

    const partial = clone(validated);
    partial.observed = [clone(canonical.observed[0]!)];
    partial.observed[0]!.verifier = "";
    partial.observed[0]!.decision = "";
    expect(
      errors(validateCanvas(partial, "publish")).some(
        (i) => i.code === "validated_requires_evidence",
      ),
    ).toBe(true);
  });

  it("rejects duplicate row ids (dedup/identity relies on them)", () => {
    const dup = clone(canonical);
    dup.observed[1]!.id = dup.observed[0]!.id;
    expect(
      errors(validateCanvas(dup, "draft")).some((i) => i.code === "duplicate_id"),
    ).toBe(true);
  });
});

describe("Measurement extension (plan sketch)", () => {
  const goodMeasurement = {
    metricId: "550e8400-e29b-41d4-a716-446655440000",
    definitionRevision: 2,
    layer: "OUTPUT",
    date: "2026-08-12",
    value: 78,
    unit: "%",
    baseline: 65,
    target: 85,
  };

  it("accepts a valid measurement on an observed row", () => {
    const withMeasurement = clone(canonical);
    (withMeasurement.observed[0] as any).measurement = goodMeasurement;
    expect(CanvasBodySchema.safeParse(withMeasurement).success).toBe(true);
    expect(errors(validateCanvas(withMeasurement, "publish"))).toEqual([]);
  });

  it.each([
    ["metricId", "not-a-uuid"],
    ["definitionRevision", 0],
    ["definitionRevision", -1],
    ["definitionRevision", 1.5],
    ["layer", "KPI"],
    ["date", "12/08/2026"],
    ["value", Number.POSITIVE_INFINITY],
    ["value", Number.NaN],
    ["unit", ""],
    ["baseline", "65"],
  ])("rejects measurement with bad %s", (key, value) => {
    const bad = { ...goodMeasurement, [key]: value };
    expect(Measurement.safeParse(bad).success).toBe(false);
  });

  it("is strict — extra keys are rejected", () => {
    expect(
      Measurement.safeParse({ ...goodMeasurement, company_id: "x" }).success,
    ).toBe(false);
  });
});

describe("fromLegacy — demo snapshot → canonical", () => {
  it("never fabricates a body from a brief-only record", () => {
    expect(fromLegacy({ v: "v1", brief: true }).body).toBeNull();
    const r = fromLegacy({ v: "v2", week: "Tuần 32", brief: true });
    expect(r.body).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    // a record with no content keys at all is also not a snapshot
    expect(fromLegacy({ v: "v9", week: "Tuần x" }).body).toBeNull();
  });

  it("maps every legacy field (cur→current, tgt→target, due→deadline, beh→behavior, own→assignee_label)", () => {
    const res = fromLegacy(legacyFull);
    expect(res.warnings).toEqual([]);
    const mapped = res.body!;
    expect(mapped).not.toBeNull();

    expect(mapped.meta.title).toBe(legacyFull.name);
    expect(mapped.meta.owner).toBe(legacyFull.owner);
    expect(mapped.meta.stage).toBe(legacyFull.stage);
    expect(mapped.meta.mode).toBe(legacyFull.mode);
    expect(mapped.meta.updated).toBe(legacyFull.date);
    expect(mapped.meta.schema).toBe("3.0");

    expect(mapped.goal.statement).toBe(legacyFull.goal);
    expect(mapped.goal.context).toBe(legacyFull.context);
    expect(mapped.solution.direction).toBe(legacyFull.direction);
    expect(mapped.solution.logic).toBe(legacyFull.logic);
    expect(mapped.risks).toBe(legacyFull.risks.join("\n"));

    expect(mapped.kr).toEqual({
      metric: legacyFull.kr.metric,
      current: legacyFull.kr.cur,
      target: legacyFull.kr.tgt,
      deadline: legacyFull.kr.due,
      cs: legacyFull.kr.cs,
    });
    mapped.outputs.forEach((o, i) => {
      const l = legacyFull.outputs[i]!;
      expect(o).toMatchObject({
        name: l.name,
        current: l.cur,
        target: l.tgt,
        deadline: l.due,
        cs: l.cs,
      });
      expect(o.id).toMatch(UUID_RE);
    });
    mapped.behaviors.forEach((b, i) => {
      const l = legacyFull.behaviors[i]!;
      expect(b).toMatchObject({
        actor: l.actor,
        behavior: l.beh,
        context: l.ctx,
        outputs: l.out,
        signal: l.sign,
        freq: l.freq,
      });
      expect(b.id).toMatch(UUID_RE);
    });
    mapped.boxes.forEach((b, i) => {
      const l = legacyFull.boxes[i]!;
      expect(b.box).toBe(SIX_BOXES[i]);
      expect(b).toMatchObject({
        condition: l.cond,
        evidence: l.ev,
        gap: l.gap,
        priority: l.pri,
        action: l.act,
        assignee_label: l.own,
      });
      // name → id link resolved
      const target = mapped.behaviors.find((x) => x.behavior === l.beh);
      expect(b.behavior_id).toBe(target!.id);
    });
    mapped.actions.forEach((a, i) => {
      const l = legacyFull.actions[i]!;
      expect(a).toMatchObject({
        action: l.act,
        start: l.start,
        deadline: l.due,
        assignee_label: l.own,
        supporter_label: l.sup,
        criteria: l.cri,
        status: l.st,
        risk: l.risk,
      });
    });
    mapped.plan.forEach((p, i) => {
      const l = legacyFull.plan[i]!;
      expect(p).toMatchObject({
        date: l.date,
        layer: l.layer,
        metric: l.metric,
        baseline: l.base,
        target: l.tgt,
        source: l.src,
        collector: l.col,
        verifier: l.ver,
      });
    });
    mapped.observed.forEach((o, i) => {
      const l = legacyFull.observed[i]!;
      expect(o).toMatchObject({
        date: l.date,
        layer: l.layer,
        value: l.val,
        source: l.src,
        confidence: l.conf,
        learning: l.learn,
        decision: l.dec,
        verifier: l.ver,
      });
    });
    mapped.reviews.forEach((r, i) => {
      const l = legacyFull.reviews[i]!;
      expect(r).toMatchObject({
        checkpoint: l.cp,
        date: l.date,
        behavior_evidence: l.be ?? "",
        output_evidence: l.oe ?? "",
        result_evidence: l.re ?? "",
        works: l.ok ?? "",
        not_works: l.no ?? "",
        learning: l.ln ?? "",
        verifier: l.ver,
      });
    });
  });

  it("produces a body identical to canonical.json modulo generated ids", () => {
    const mapped = fromLegacy(legacyFull).body!;
    expect(normalizeIds(mapped)).toEqual(normalizeIds(canonical));
  });

  it("mapped body is schema-valid and publishable", () => {
    const mapped = fromLegacy(legacyFull).body!;
    expect(CanvasBodySchema.safeParse(mapped).success).toBe(true);
    expect(errors(validateCanvas(mapped, "publish"))).toEqual([]);
    expect(
      CanvasBodySchema.safeParse({ ...mapped, company_id: "injected" }).success,
    ).toBe(false);
  });

  it("warns on unknown keys, bad enums, unresolvable behavior names — never silent", () => {
    const weird = clone(legacyFull);
    weird.company_id = "smuggle";
    weird.mystery = 1;
    weird.stage = "EXPLODING";
    weird.actions = [{ ...weird.actions[0], st: "DONE?" }];
    weird.boxes = [{ ...weird.boxes[0], beh: "hành vi không tồn tại" }, ...weird.boxes.slice(1)];
    const res = fromLegacy(weird);
    const text = res.warnings.join("\n");
    expect(text).toContain("company_id");
    expect(text).toContain("mystery");
    expect(text).toContain("EXPLODING");
    expect(text).toContain("DONE?");
    expect(text).toContain("hành vi không tồn tại");
    expect(res.body!.boxes[0]!.behavior_id).toBeNull();
    expect(res.body!.meta.stage).toBe("DRAFT"); // warned fallback
  });

  it("normalizes DD/MM/YYYY legacy dates in date-typed fields and preserves free-text deadlines", () => {
    const dated = clone(legacyFull);
    dated.actions[0] = { ...dated.actions[0], due: "31/12/2026" };
    dated.kr = { ...dated.kr, due: "31/12/2026" };
    const res = fromLegacy(dated);
    expect(res.body!.actions[0]!.deadline).toBe("2026-12-31");
    // kr/output deadlines are free text in the editor — preserved verbatim
    expect(res.body!.kr.deadline).toBe("31/12/2026");
  });
});

describe("fromLegacy — schema-valid by construction", () => {
  it("warns + blanks an impossible ISO date instead of passing it through", () => {
    const bad = clone(legacyFull);
    bad.observed[0] = { ...bad.observed[0], date: "2026-13-45" };
    const res = fromLegacy(bad);
    expect(res.body!.observed[0]!.date).toBe("");
    expect(res.warnings.join("\n")).toContain("2026-13-45");
    expect(CanvasBodySchema.safeParse(res.body).success).toBe(true);
  });

  it("warns when an ISO date is embedded in surrounding text (kept, text flagged)", () => {
    const bad = clone(legacyFull);
    bad.plan[0] = { ...bad.plan[0], date: "hạn 2026-09-30 theo chốt" };
    const res = fromLegacy(bad);
    expect(res.body!.plan[0]!.date).toBe("2026-09-30");
    expect(res.warnings.join("\n")).toContain("hạn 2026-09-30 theo chốt");
  });

  it("truncates over-bound lists (outputs >3, behaviors >5) with warnings", () => {
    const wide = clone(legacyFull);
    wide.outputs = [0, 1, 2, 3].map(() => clone(legacyFull.outputs[0]));
    wide.behaviors = [0, 1, 2, 3, 4, 5].map((i) =>
      clone(legacyFull.behaviors[i % legacyFull.behaviors.length]!),
    );
    const res = fromLegacy(wide);
    expect(res.body!.outputs).toHaveLength(3);
    expect(res.body!.behaviors).toHaveLength(5);
    const text = res.warnings.join("\n");
    expect(text).toContain("outputs");
    expect(text).toContain("behaviors");
    expect(CanvasBodySchema.safeParse(res.body).success).toBe(true);
  });

  it("warns when required enums are absent or blank — never a silent default", () => {
    const noStage = clone(legacyFull);
    delete noStage.stage;
    noStage.actions = [{ ...noStage.actions[0], st: "" }];
    const res = fromLegacy(noStage);
    const text = res.warnings.join("\n");
    expect(text).toContain("stage");
    expect(text).toContain("st");
    expect(res.body!.meta.stage).toBe("DRAFT");
    expect(res.body!.actions[0]!.status).toBe("Chưa bắt đầu");
  });

  it("final gate: returns body:null rather than a schema-invalid body", async () => {
    // Every coercion path produces schema-legal values, so the gate is only
    // reachable if a future change regresses — force it by corrupting newId.
    vi.doMock("../../shared/canvas/defaults.js", async (importOriginal) => {
      const orig =
        await importOriginal<typeof import("../../shared/canvas/defaults.js")>();
      return { ...orig, newId: () => "not-a-uuid" };
    });
    try {
      vi.resetModules();
      const { fromLegacy: guarded } = await import(
        "../../shared/canvas/legacy.js"
      );
      const res = guarded(legacyFull);
      expect(res.body).toBeNull();
      expect(res.warnings.length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock("../../shared/canvas/defaults.js");
      vi.resetModules();
    }
  });

  it.each([
    { ...legacyFull, kr: "không phải object" },
    { ...legacyFull, boxes: "không phải mảng" },
    { ...legacyFull, observed: [{ date: "32/13/2026" }] },
    { ...legacyFull, actions: [{ act: "x", st: "??" }] },
    { ...legacyFull, name: 5, date: "mùa thu" },
    { goal: "partial snapshot — chỉ có mục tiêu" },
  ])("never returns a body that fails CanvasBodySchema: %#", (mutant) => {
    const res = fromLegacy(mutant);
    if (res.body !== null) {
      expect(CanvasBodySchema.safeParse(res.body).success).toBe(true);
    }
  });
});
