import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateCoachOutput,
  COACH_RUBRIC,
} from "../../server/src/modules/ai/coach.js";
import type { CanvasBody } from "../../shared/canvas/schema.js";

/**
 * Task 3.5 — Canvas Coach output validation (spec §7.3, source rubric v3.0).
 *
 * The coach is read-only advice: its output is validated against the
 * FROZEN rubric (criterion ids and max allocations come from
 * `Skill/canvas-coach/references/grading.md`, never from the model), and
 * every evidence/source ref must resolve to a real row id or section
 * token of the input canvas — invented references are rejected.
 */

const canvas = JSON.parse(
  readFileSync(
    new URL("../fixtures/canvas/canonical.json", import.meta.url),
    "utf8",
  ),
) as CanvasBody;

const cases = JSON.parse(
  readFileSync(
    new URL("../fixtures/ai/coach-cases.json", import.meta.url),
    "utf8",
  ),
) as { valid: Record<string, unknown>; truncated: string };

function validCoach(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(cases.valid));
}

/** A criterion override helper — returns a copy of valid criteria. */
function criteria(): Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(cases.valid.criteria));
}

describe("validateCoachOutput (task 3.5)", () => {
  it("accepts a well-formed rubric v3.0 output", () => {
    const out = validateCoachOutput(validCoach(), canvas);
    expect(out.rubricVersion).toBe("3.0");
    expect(out.total).toBe(69);
    expect(out.criteria).toHaveLength(COACH_RUBRIC.length);
  });

  it("rejects a total that does not equal the criterion sum", () => {
    const bad = { ...validCoach(), total: 99 };
    expect(() => validateCoachOutput(bad, canvas)).toThrow(
      "SCORE_TOTAL_MISMATCH",
    );
  });

  it("rejects a criterion score above/below its range", () => {
    const c = criteria();
    c[0] = { ...c[0], score: 9 }; // goal max is 8
    expect(() =>
      validateCoachOutput({ ...validCoach(), criteria: c }, canvas),
    ).toThrow("SCORE_OUT_OF_RANGE");

    const neg = criteria();
    neg[1] = { ...neg[1], score: -1 };
    expect(() =>
      validateCoachOutput({ ...validCoach(), criteria: neg }, canvas),
    ).toThrow("SCORE_OUT_OF_RANGE");
  });

  it("rejects a model-chosen max — the versioned rubric owns allocations", () => {
    const c = criteria();
    c[0] = { ...c[0], max: 10, score: 6 };
    // total still sums correctly vs listed scores — the max itself is wrong
    const total = (c as { score: number }[]).reduce((n, x) => n + x.score, 0);
    expect(() =>
      validateCoachOutput({ ...validCoach(), criteria: c, total }, canvas),
    ).toThrow("CRITERION_MAX_MISMATCH");
  });

  it("rejects unknown, missing, and duplicated criterion ids", () => {
    const unknown = criteria();
    unknown[0] = { ...unknown[0], id: "invented_criterion" };
    expect(() =>
      validateCoachOutput({ ...validCoach(), criteria: unknown }, canvas),
    ).toThrow("UNKNOWN_CRITERION");

    const missing = criteria().slice(1);
    const missingTotal = 69 - 6;
    expect(() =>
      validateCoachOutput(
        { ...validCoach(), criteria: missing, total: missingTotal },
        canvas,
      ),
    ).toThrow("MISSING_CRITERION");

    const dup = [...criteria(), { ...criteria()[5]! }];
    expect(() =>
      validateCoachOutput({ ...validCoach(), criteria: dup }, canvas),
    ).toThrow("DUPLICATE_CRITERION");
  });

  it("rejects a wrong rubric version", () => {
    expect(() =>
      validateCoachOutput(
        { ...validCoach(), rubricVersion: "2.0" },
        canvas,
      ),
    ).toThrow("RUBRIC_VERSION_MISMATCH");
  });

  it("rejects invented evidence references — refs must exist in the canvas", () => {
    const c = criteria();
    c[1] = { ...c[1], evidenceRefs: ["missing-id"] };
    expect(() =>
      validateCoachOutput({ ...validCoach(), criteria: c }, canvas),
    ).toThrow("UNKNOWN_EVIDENCE_REFERENCE");

    expect(() =>
      validateCoachOutput(
        {
          ...validCoach(),
          advice: [
            {
              kind: "Fact",
              text: "Đã đạt KPI",
              sourceRefs: ["missing-id"],
            },
          ],
        },
        canvas,
      ),
    ).toThrow("UNKNOWN_EVIDENCE_REFERENCE");
  });

  it("rejects a positive score with no evidence — no confidence laundering", () => {
    const c = criteria();
    c[0] = { ...c[0], score: 5, evidenceRefs: [] };
    expect(() =>
      validateCoachOutput({ ...validCoach(), criteria: c }, canvas),
    ).toThrow("MISSING_EVIDENCE");

    // A zero score legitimately has no evidence — allowed.
    const zero = criteria();
    zero[0] = { ...zero[0], score: 0, evidenceRefs: [] };
    const total = (zero as { score: number }[]).reduce(
      (n, x) => n + x.score,
      0,
    );
    const out = validateCoachOutput(
      { ...validCoach(), criteria: zero, total },
      canvas,
    );
    expect(out.criteria[0]!.score).toBe(0);
  });

  it("rejects a Fact without source refs — labels cannot launder confidence", () => {
    expect(() =>
      validateCoachOutput(
        {
          ...validCoach(),
          advice: [{ kind: "Fact", text: "Đạt KPI", sourceRefs: [] }],
        },
        canvas,
      ),
    ).toThrow("FACT_REQUIRES_EVIDENCE");

    // An Assumption may carry zero refs — it is explicitly unverified.
    const out = validateCoachOutput(
      {
        ...validCoach(),
        advice: [
          {
            kind: "Assumption",
            text: "Giả định nguyên nhân là chất lượng dữ liệu đầu vào.",
            sourceRefs: [],
            confidence: "low",
          },
        ],
      },
      canvas,
    );
    expect(out.advice[0]!.kind).toBe("Assumption");
  });

  it("rejects labels outside the epistemic enum", () => {
    expect(() =>
      validateCoachOutput(
        {
          ...validCoach(),
          advice: [{ kind: "Opinion", text: "Cảm giác", sourceRefs: [] }],
        },
        canvas,
      ),
    ).toThrow("COACH_OUTPUT_INVALID");
  });

  it("rejects non-object input and schema violations", () => {
    for (const raw of [null, "text", 42, [], { rubricVersion: "3.0" }]) {
      expect(() => validateCoachOutput(raw, canvas)).toThrow(
        "COACH_OUTPUT_INVALID",
      );
    }
  });
});
