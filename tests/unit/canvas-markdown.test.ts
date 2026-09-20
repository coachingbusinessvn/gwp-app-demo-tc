import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CanvasBodySchema,
  SIX_BOXES,
  type CanvasBody,
} from "../../shared/canvas/schema.js";
import { parseMarkdown, toMarkdown } from "../../shared/canvas/markdown.js";
import { validateCanvas, type Issue } from "../../shared/canvas/validation.js";

/**
 * Task 2.2 — loss-aware canonical ⇄ Markdown round-trip.
 *
 * canonical.md is the golden Markdown rendering of canonical.json:
 * `toMarkdown(canonical.json)` reproduces it byte-for-byte and
 * `parseMarkdown(canonical.md)` rebuilds the body modulo generated row ids
 * (Markdown carries behavior *names* in box links, never ids — ids
 * regenerate on every import).
 */
const canonical = JSON.parse(
  readFileSync(new URL("../fixtures/canvas/canonical.json", import.meta.url), "utf8"),
) as CanvasBody;
const canonicalMd = readFileSync(
  new URL("../fixtures/canvas/canonical.md", import.meta.url),
  "utf8",
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function errors(issues: Issue[]) {
  return issues.filter((i) => i.severity === "error");
}

function warnings(issues: Issue[]) {
  return issues.filter((i) => i.severity === "warning");
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

const HEAD = (title: string, meta = "") =>
  `# PERFORMANCE ARCHITECTURE CANVAS — ${title}\n\n` +
  (meta ||
    "**Canvas Stage:** DRAFT · **Build Mode:** GUIDED · **Schema Version:** 3.0 · **Last Updated:** 2026-09-20 · **Migration Status:** Native v3") +
  "\n\n";

const SEC1 = "## 1. GOAL | MỤC TIÊU\n\nMục tiêu thử nghiệm.\n\n";
const SEC2 =
  "## 2. KEY RESULT + CRITICAL OUTPUTS / CS\n\n" +
  "| Thành phần | Loại | Hiện tại | Mục tiêu | Thời hạn | Tiêu chuẩn chất lượng (CS) |\n" +
  "|---|---|---|---|---|---|\n" +
  "| Chỉ số A | Key Result | 1 | 2 | 31/12/2026 | CS chuẩn |\n\n";
const SEC3 =
  "## 3. SOLUTION DIRECTION + LEVER BEHAVIORS\n\n" +
  "**Solution Direction:** Hướng X.\n\n" +
  "| Chủ thể | Lever Behavior | Bối cảnh | Output tác động | Dấu hiệu quan sát được | Tần suất |\n" +
  "|---|---|---|---|---|---|\n" +
  "| Nhân viên | Hành vi một | ctx | out | sig | f |\n" +
  "| Tổ trưởng | Hành vi hai | ctx | out | sig | f |\n\n";
const SEC4 =
  "## 4. CONDITIONS | 6 BOXES\n\n" +
  "| 6 Boxes | Điều kiện cần | Hiện trạng / Bằng chứng | Khoảng cách | Ưu tiên | Hành vi liên quan | Hành động sơ bộ | Người sở hữu |\n" +
  "|---|---|---|---|---|---|---|---|\n" +
  "| Kỳ vọng & Phản hồi | c1 | e1 | Cao | Cao | Hành vi một | a1 | o1 |\n" +
  "| Công cụ & Nguồn lực | c2 | e2 | Thấp | Thấp | Hành vi hai | a2 | o2 |\n" +
  "| Hệ quả & Ghi nhận | c3 | e3 | Trung bình | Chưa xác định | Cần xác nhận | a3 | o3 |\n" +
  "| Kiến thức & Kỹ năng | c4 | e4 | Cao | Cao | Không tồn tại | a4 | o4 |\n" +
  "| Vai trò & Quyền hạn | c5 | e5 | Cao | Cao | | a5 | o5 |\n" +
  "| Động lực & Ưu tiên | c6 | e6 | Cao | Cao | Hành vi | a6 | o6 |\n\n";
const SEC5 =
  "## 5. ACTION EXPERIMENT\n\n" +
  "| Action | Start | Deadline | Owner | Supporter | Success Criteria | Status | Risk / Adjustment |\n" +
  "|---|---|---|---|---|---|---|---|\n" +
  "| Việc A | 2026-09-21 | 2026-09-30 | Tổ trưởng | QA | xong | Đang thực hiện | r |\n\n" +
  "**Rủi ro / Giả định cần kiểm chứng:**\n\n" +
  "- Rủi ro một\n- Giả định hai\n\n";
const SEC6 =
  "## 6. FOLLOW-UP EVIDENCE APPROPRIATE TO STAGE\n\n" +
  "### Measurement Plan\n\n" +
  "| planned_date | evidence_layer | metric_or_criterion | baseline | target | data_source | collector | verifier |\n" +
  "|---|---|---|---|---|---|---|---|\n" +
  "| 2026-09-30 | OUTPUT | m | 0 | 1 | src | col | ver |\n\n" +
  "### Observed Evidence\n\n" +
  "| observed_date | evidence_layer | value_or_evidence | source_reference | confidence | learning | decision | verifier |\n" +
  "|---|---|---|---|---|---|---|---|\n\n" +
  "### Lịch Review & bài học\n\n" +
  "| Mốc Review | Ngày | Behavior Evidence | Output Evidence | Result Evidence | Điều hiệu quả | Điều chưa hiệu quả | Learning & Next Step | Người xác nhận |\n" +
  "|---|---|---|---|---|---|---|---|---|\n" +
  "| Sau 7 ngày | 2026-09-27 | be | oe | re | w | nw | ln | ver |\n";

const MINIMAL = HEAD("Test canvas") + SEC1 + SEC2 + SEC3 + SEC4 + SEC5 + SEC6;

/** Same document with every box link resolvable — for zero-error asserts. */
const MINIMAL_CLEAN = MINIMAL.replace("| Không tồn tại |", "| Hành vi một |").replace(
  "| Hành vi | a6 | o6 |",
  "| Hành vi hai | a6 | o6 |",
);

describe("toMarkdown", () => {
  it("emits all six canonical sections and no internal metadata", () => {
    const { text } = toMarkdown(canonical);
    expect(text).toContain(
      `# PERFORMANCE ARCHITECTURE CANVAS — ${canonical.meta.title}`,
    );
    for (const h of [
      "## 1.",
      "## 2.",
      "## 3.",
      "## 4.",
      "## 5.",
      "## 6.",
      "### Measurement Plan",
      "### Observed Evidence",
      "### Lịch Review",
    ]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("**Canvas Stage:** PILOTING");
    expect(text).toContain(`**Người lập:** ${canonical.meta.owner}`);
    // zero metadata leakage: no ids, no privilege/server fields
    expect(text).not.toMatch(UUID_RE);
    for (const key of [
      "behavior_id",
      "assignee_user_id",
      "company_id",
      "owner_user_id",
      "schema_version",
      "canvas_id",
    ]) {
      expect(text).not.toContain(key);
    }
    // box→behavior link rendered as the behavior NAME, not an id
    const boxRow = text
      .split("\n")
      .find((l) => l.includes("Expectations & Feedback"))!;
    expect(boxRow).toContain(canonical.behaviors[1]!.behavior);
    // all six box rows are always emitted (drafts included)
    for (const name of SIX_BOXES) {
      const vn = name.split(" | ")[0]!;
      const en = name.split(" | ")[1]!;
      expect(text).toContain(`${vn} \\| ${en}`);
    }
  });

  it("warns JSON_REQUIRED_FOR_EXTENSIONS when extension fields can't survive", () => {
    const withExt = clone(canonical);
    (withExt.observed[0] as any).measurement = {
      metricId: "550e8400-e29b-41d4-a716-446655440000",
      definitionRevision: 2,
      layer: "OUTPUT",
      date: "2026-08-12",
      value: 78,
      unit: "%",
      baseline: 65,
      target: 85,
    };
    (withExt.actions[0] as any).assignee_user_id =
      "550e8400-e29b-41d4-a716-446655440001";
    (withExt.boxes[0] as any).assignee_user_id =
      "550e8400-e29b-41d4-a716-446655440002";
    const { warnings: w } = toMarkdown(withExt);
    expect(w).toContain("JSON_REQUIRED_FOR_EXTENSIONS");
    const joined = w.join("\n");
    expect(joined).toContain("observed");
    expect(joined).toContain("assignee_user_id");
    // a clean body does not raise the extension warning
    expect(toMarkdown(canonical).warnings).not.toContain(
      "JSON_REQUIRED_FOR_EXTENSIONS",
    );
  });

  it("warns when a cell value collides with a placeholder (silent on reimport)", () => {
    const b = clone(canonical);
    b.outputs[0]!.cs = "TBD";
    const { text, warnings: w } = toMarkdown(b);
    expect(w.some((x) => x.includes("TBD"))).toBe(true);
    const parsed = parseMarkdown(text);
    expect(parsed.body!.outputs[0]!.cs).toBe("");
  });
});

describe("round-trip canonical ⇄ markdown", () => {
  it("toMarkdown(canonical) → parseMarkdown reproduces every section modulo ids", () => {
    const { text } = toMarkdown(canonical);
    const parsed = parseMarkdown(text);
    expect(errors(parsed.issues)).toEqual([]);
    expect(parsed.body).not.toBeNull();
    expect(parsed.body!.goal).toEqual(canonical.goal);
    expect(parsed.body!.solution).toEqual(canonical.solution);
    expect(parsed.body!.risks).toEqual(canonical.risks);
    expect(normalizeIds(parsed.body!)).toEqual(normalizeIds(canonical));
  });

  it("golden fixture canonical.md parses to the canonical body modulo ids", () => {
    const parsed = parseMarkdown(canonicalMd);
    expect(errors(parsed.issues)).toEqual([]);
    expect(parsed.body).not.toBeNull();
    expect(normalizeIds(parsed.body!)).toEqual(normalizeIds(canonical));
    expect(CanvasBodySchema.safeParse(parsed.body).success).toBe(true);
    expect(errors(validateCanvas(parsed.body, "publish"))).toEqual([]);
  });

  it("toMarkdown(canonical) reproduces canonical.md byte-for-byte", () => {
    expect(toMarkdown(canonical).text).toBe(canonicalMd);
  });

  it("escapes pipes, newlines, backslashes, asterisks; Vietnamese intact", () => {
    const nasty = clone(canonical);
    nasty.outputs[0]!.name = "Cuộc gọi | đạt chuẩn\n(tiếng Việt)";
    nasty.outputs[0]!.deadline = "(chưa điền)";
    nasty.behaviors[0]!.behavior = "Đọc \\ kỹ | hồ sơ\nmở đầu xác nhận";
    nasty.actions[0]!.action = "**Chú ý:** gọi sớm | đúng chuẩn";
    nasty.reviews[0]!.works = "hiệu quả\ntiếp tục — đề xuất";
    nasty.plan[0]!.metric = "Tuần đủ 20 cuộc | có biên bản";
    const { text } = toMarkdown(nasty);
    const parsed = parseMarkdown(text);
    expect(errors(parsed.issues)).toEqual([]);
    expect(normalizeIds(parsed.body!)).toEqual(normalizeIds(nasty));
  });
});

describe("parseMarkdown — named behavior links", () => {
  it("resolves exact trimmed names → behavior_id; 'Cần xác nhận'/blank → null", () => {
    const parsed = parseMarkdown(MINIMAL);
    const boxes = parsed.body!.boxes;
    expect(boxes[0]!.behavior_id).toBe(parsed.body!.behaviors[0]!.id);
    expect(boxes[1]!.behavior_id).toBe(parsed.body!.behaviors[1]!.id);
    expect(boxes[2]!.behavior_id).toBeNull(); // "Cần xác nhận"
    expect(boxes[4]!.behavior_id).toBeNull(); // blank cell
    const refIssues = parsed.issues.filter(
      (i) => i.path.endsWith(".behavior_id"),
    );
    // only slots 3 (Không tồn tại) and 5 ("Hành vi" partial) error
    expect(refIssues.map((i) => i.path).sort()).toEqual([
      "boxes.3.behavior_id",
      "boxes.5.behavior_id",
    ]);
  });

  it("missing or ambiguous names → blocking error, row preserved", () => {
    const parsed = parseMarkdown(MINIMAL);
    const miss = errors(parsed.issues).find(
      (i) => i.path === "boxes.3.behavior_id",
    )!;
    expect(miss.code).toBe("AMBIGUOUS_OR_MISSING_REFERENCE");
    expect(miss.message).toContain("Không tồn tại");
    // no substring matching: "Hành vi" is a prefix of both behaviors → missing
    const partial = errors(parsed.issues).find(
      (i) => i.path === "boxes.5.behavior_id",
    )!;
    expect(partial.code).toBe("AMBIGUOUS_OR_MISSING_REFERENCE");
    // the row itself is preserved, not dropped
    expect(parsed.body!.boxes[3]!.condition).toBe("c4");
    expect(parsed.body!.boxes[3]!.behavior_id).toBeNull();
    expect(parsed.body!.boxes[5]!.condition).toBe("c6");
  });

  it("duplicate behavior names make the reference ambiguous", () => {
    const dup = MINIMAL.replace(
      "| Tổ trưởng | Hành vi hai |",
      "| Tổ trưởng | Hành vi một |",
    );
    const parsed = parseMarkdown(dup);
    const ambiguous = errors(parsed.issues).filter(
      (i) => i.code === "AMBIGUOUS_OR_MISSING_REFERENCE",
    );
    expect(ambiguous.map((i) => i.path)).toContain("boxes.0.behavior_id");
    expect(parsed.body!.boxes[0]!.behavior_id).toBeNull();
  });
});

describe("parseMarkdown — loss-aware issues, never throws", () => {
  it("returns body:null + blocking error for non-canvas text", () => {
    const r = parseMarkdown("Đây là một đoạn văn thường, không phải canvas.");
    expect(r.body).toBeNull();
    expect(errors(r.issues).some((i) => i.code === "NOT_A_CANVAS")).toBe(true);
  });

  it("missing sections → warning issues with paths, body keeps blanks", () => {
    const r = parseMarkdown(HEAD("Chỉ có goal") + SEC1);
    expect(r.body).not.toBeNull();
    for (const n of ["2", "3", "4", "5", "6"]) {
      expect(
        r.issues.some(
          (i) => i.code === "MISSING_SECTION" && i.path === `section.${n}`,
        ),
      ).toBe(true);
    }
    expect(r.body!.boxes).toHaveLength(6);
    expect(r.body!.boxes.every((b) => b.condition === "")).toBe(true);
    expect(r.body!.goal.statement).toBe("Mục tiêu thử nghiệm.");
    expect(CanvasBodySchema.safeParse(r.body).success).toBe(true);
  });

  it("unknown ## / ### headings warn instead of silently swallowing content", () => {
    const md =
      HEAD("T") + SEC1 + "## 7. PHẦN LẠ\n\nnội dung lạ\n\n" + SEC2 + SEC3 +
      SEC4 + SEC5 + SEC6.replace(
        "### Lịch Review",
        "### Mục con lạ\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n### Lịch Review",
      );
    const r = parseMarkdown(md);
    expect(
      warnings(r.issues).some((i) => i.code === "UNKNOWN_SECTION"),
    ).toBe(true);
    expect(
      warnings(r.issues).some((i) => i.code === "UNKNOWN_SUBSECTION"),
    ).toBe(true);
  });

  it("column count mismatch → warning issue, row still kept", () => {
    const md = MINIMAL.replace(
      "| Việc A | 2026-09-21 | 2026-09-30 | Tổ trưởng | QA | xong | Đang thực hiện | r |",
      "| Việc A | 2026-09-21 | 2026-09-30 |",
    );
    const r = parseMarkdown(md);
    expect(
      warnings(r.issues).some((i) => i.code === "COLUMN_COUNT_MISMATCH"),
    ).toBe(true);
    expect(r.body!.actions[0]!.action).toBe("Việc A");
    expect(r.body!.actions[0]!.status).toBe("Chưa bắt đầu"); // fell back
  });

  it("unknown enum text → warning + explicit fallback (no silent default)", () => {
    const md = MINIMAL.replace(
      "**Canvas Stage:** DRAFT",
      "**Canvas Stage:** EXPLODING",
    ).replace("| Cao | Cao | Hành vi một |", "| Khổng lồ | Cao | Hành vi một |");
    const r = parseMarkdown(md);
    expect(r.body!.meta.stage).toBe("DRAFT");
    expect(r.body!.boxes[0]!.gap).toBe("");
    const text = r.issues.map((i) => i.message).join("\n");
    expect(text).toContain("EXPLODING");
    expect(text).toContain("Khổng lồ");
    expect(r.issues.some((i) => i.code === "INVALID_ENUM")).toBe(true);
  });

  it("unparseable meta.updated → warning + blank", () => {
    const md = MINIMAL.replace("**Last Updated:** 2026-09-20", "**Last Updated:** hôm qua");
    const r = parseMarkdown(md);
    expect(r.body!.meta.updated).toBe("");
    expect(r.issues.some((i) => i.path === "meta.updated")).toBe(true);
  });

  it("unrecognized box name warns; missing canonical box gets a blank row", () => {
    const md = MINIMAL.replace(
      "| Kỳ vọng & Phản hồi | c1 | e1 | Cao | Cao | Hành vi một | a1 | o1 |",
      "| Box bậy bạ | c1 | e1 | Cao | Cao | Hành vi một | a1 | o1 |",
    );
    const r = parseMarkdown(md);
    expect(
      warnings(r.issues).some((i) => i.code === "UNRECOGNIZED_BOX"),
    ).toBe(true);
    expect(
      warnings(r.issues).some((i) => i.code === "MISSING_BOX"),
    ).toBe(true);
    expect(r.body!.boxes).toHaveLength(6);
    expect(r.body!.boxes[0]!.box).toBe(SIX_BOXES[0]);
    expect(r.body!.boxes[0]!.condition).toBe("");
  });

  it("truncates over-bound lists (outputs >3, behaviors >5) with warnings", () => {
    const extraOutput =
      "| Out X | Critical Output | 1 | 2 | d | cs |\n| Out Y | Critical Output | 1 | 2 | d | cs |\n| Out Z | Critical Output | 1 | 2 | d | cs |\n| Out W | Critical Output | 1 | 2 | d | cs |";
    const md = MINIMAL.replace(
      "| Chỉ số A | Key Result | 1 | 2 | 31/12/2026 | CS chuẩn |",
      "| Chỉ số A | Key Result | 1 | 2 | 31/12/2026 | CS chuẩn |\n" + extraOutput,
    );
    const r = parseMarkdown(md);
    expect(r.body!.outputs).toHaveLength(3);
    expect(
      warnings(r.issues).some((i) => i.code === "LIST_TRUNCATED"),
    ).toBe(true);
  });

  it("drops fully-blank table rows but keeps partially filled ones", () => {
    const md = MINIMAL.replace(
      "| Sau 7 ngày | 2026-09-27 | be | oe | re | w | nw | ln | ver |",
      "| | | | | | | | | |\n| Sau 7 ngày | 2026-09-27 | be | oe | re | w | nw | ln | ver |",
    );
    const r = parseMarkdown(md);
    expect(r.body!.reviews).toHaveLength(1);
    expect(r.body!.reviews[0]!.checkpoint).toBe("Sau 7 ngày");
  });

  it("DRAFT-stage TBD observed placeholder row normalizes to no rows", () => {
    const md = MINIMAL_CLEAN.replace(
      "|---|---|---|---|---|---|---|---|\n\n### Lịch Review",
      "|---|---|---|---|---|---|---|---|\n| TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |\n\n### Lịch Review",
    );
    const r = parseMarkdown(md);
    expect(errors(r.issues)).toEqual([]);
    expect(r.body!.observed).toHaveLength(0);
  });

  it("parses DD/MM/YYYY dates in typed fields and validates real calendar dates", () => {
    const md = MINIMAL.replace(
      "| Việc A | 2026-09-21 | 2026-09-30 |",
      "| Việc A | 21/09/2026 | 2026-13-45 |",
    );
    const r = parseMarkdown(md);
    expect(r.body!.actions[0]!.start).toBe("2026-09-21");
    expect(r.body!.actions[0]!.deadline).toBe("");
    expect(r.issues.some((i) => i.path === "actions.0.deadline")).toBe(true);
  });

  it("keeps kr/output deadlines verbatim as free text", () => {
    const r = parseMarkdown(MINIMAL);
    expect(r.body!.kr.deadline).toBe("31/12/2026");
  });

  it("parsed body is schema-valid and gets fresh UUID row ids", () => {
    const r = parseMarkdown(MINIMAL);
    expect(CanvasBodySchema.safeParse(r.body).success).toBe(true);
    for (const row of [
      ...r.body!.outputs,
      ...r.body!.behaviors,
      ...r.body!.boxes,
      ...r.body!.actions,
      ...r.body!.plan,
      ...r.body!.observed,
      ...r.body!.reviews,
    ]) {
      expect(row.id).toMatch(UUID_RE);
    }
  });
});

describe("review fixes — silent-drop and collision regressions", () => {
  it("captures inline content on the '**Rủi ro …:**' label line (I-1)", () => {
    const md = MINIMAL.replace(
      "**Rủi ro / Giả định cần kiểm chứng:**\n\n- Rủi ro một\n- Giả định hai",
      "**Rủi ro / Giả định cần kiểm chứng:** INLINE_RISK_CONTENT",
    );
    const r = parseMarkdown(md);
    expect(r.body!.risks).toBe("INLINE_RISK_CONTENT");
    // bullets on following lines still append after the inline text
    const md2 = MINIMAL.replace(
      "**Rủi ro / Giả định cần kiểm chứng:**",
      "**Rủi ro / Giả định cần kiểm chứng:** INLINE_RISK_CONTENT",
    );
    const r2 = parseMarkdown(md2);
    expect(r2.body!.risks).toContain("INLINE_RISK_CONTENT");
    expect(r2.body!.risks).toContain("Rủi ro một");
  });

  it("a behavior literally named 'Cần xác nhận' resolves by name + MARKER_COLLISION (I-2)", () => {
    const md = MINIMAL.replace(
      "| Tổ trưởng | Hành vi hai |",
      "| Tổ trưởng | Cần xác nhận |",
    );
    const r = parseMarkdown(md);
    const marker = r.body!.behaviors.find((b) => b.behavior === "Cần xác nhận")!;
    // box 2's cell "Cần xác nhận" links to the real behavior — never silently null
    expect(r.body!.boxes[2]!.behavior_id).toBe(marker.id);
    expect(
      r.issues.some(
        (i) => i.code === "MARKER_COLLISION" && i.path === "boxes.2.behavior_id",
      ),
    ).toBe(true);
    expect(
      errors(r.issues).filter((i) => i.path === "boxes.2.behavior_id"),
    ).toEqual([]);
    // with NO behavior of that name the same cell is the undecided marker
    const r0 = parseMarkdown(MINIMAL);
    expect(r0.body!.boxes[2]!.behavior_id).toBeNull();
    expect(
      r0.issues.filter((i) => i.path === "boxes.2.behavior_id"),
    ).toEqual([]);
  });

  it("export warns when a linked box points to the collision-named behavior; reimport relinks (I-2)", () => {
    const b = clone(canonical);
    b.behaviors[0]!.behavior = "Cần xác nhận";
    b.boxes[0]!.behavior_id = b.behaviors[0]!.id;
    const { text, warnings: w } = toMarkdown(b);
    expect(
      w.some((x) => x.includes("boxes.0") && x.includes("Cần xác nhận")),
    ).toBe(true);
    const r = parseMarkdown(text);
    expect(r.body!.boxes[0]!.behavior_id).toBe(r.body!.behaviors[0]!.id);
    expect(
      r.issues.some(
        (i) => i.code === "MARKER_COLLISION" && i.path === "boxes.0.behavior_id",
      ),
    ).toBe(true);
  });

  it("duplicate labeled prose lines warn DUPLICATE_LABEL instead of vanishing (M-1)", () => {
    const md = MINIMAL.replace(
      "Mục tiêu thử nghiệm.\n",
      "Mục tiêu thử nghiệm.\n\n**Bối cảnh & phạm vi:** ctx chính\n\n**Solution Direction:** lạc mục\n",
    );
    const r = parseMarkdown(md);
    expect(r.body!.goal.context).toContain("ctx chính");
    expect(
      warnings(r.issues).some(
        (i) => i.code === "DUPLICATE_LABEL" && i.message.includes("Solution Direction"),
      ),
    ).toBe(true);
  });

  it("export warns when meta.title/meta.owner equal a placeholder token (M-2)", () => {
    const b = clone(canonical);
    b.meta.title = "TBD";
    b.meta.owner = "(chưa điền)";
    const { warnings: w } = toMarkdown(b);
    expect(w.some((x) => x.includes("meta.title"))).toBe(true);
    expect(w.some((x) => x.includes("meta.owner"))).toBe(true);
  });

  it("single newlines round-trip in multi-line fields; only labeled prose warns (M-3)", () => {
    const b = clone(canonical);
    b.goal.statement = "Dòng một\nDòng hai";
    b.goal.context = "ctx một\nctx hai";
    b.risks = "rủi ro một\nrủi ro hai";
    const { text, warnings: w } = toMarkdown(b);
    expect(w.some((x) => x.includes("goal.statement"))).toBe(false);
    expect(w.some((x) => x.includes("risks"))).toBe(false);
    expect(
      w.some((x) => x.includes("goal.context") && x.includes("xuống dòng")),
    ).toBe(true);
    const r = parseMarkdown(text);
    expect(r.body!.goal.statement).toBe("Dòng một\nDòng hai");
    expect(r.body!.risks).toBe("rủi ro một\nrủi ro hai");
    expect(r.body!.goal.context).toContain("ctx một");
    expect(r.body!.goal.context).toContain("ctx hai");
  });

  it("bold text sharing a label word but lacking a colon is UNPARSED_CONTENT (M-4)", () => {
    const md = MINIMAL.replace(
      "Mục tiêu thử nghiệm.\n",
      "Mục tiêu thử nghiệm.\n\n**Bối cảnh đẹp quá** foo\n",
    );
    const r = parseMarkdown(md);
    expect(
      warnings(r.issues).some(
        (i) =>
          i.code === "UNPARSED_CONTENT" && i.message.includes("Bối cảnh đẹp quá"),
      ),
    ).toBe(true);
    expect(
      warnings(r.issues).filter((i) => i.code === "DUPLICATE_LABEL"),
    ).toEqual([]);
  });

  it("meta labels inside later sections never override preamble metadata (M-6)", () => {
    const md = MINIMAL.replace(
      "| Việc A | 2026-09-21 | 2026-09-30 | Tổ trưởng | QA | xong | Đang thực hiện | r |\n",
      "| Việc A | 2026-09-21 | 2026-09-30 | Tổ trưởng | QA | xong | Đang thực hiện | r |\n\n**Canvas Stage:** VALIDATED\n\n**Người lập:** Evil Override\n",
    );
    const r = parseMarkdown(md);
    expect(r.body!.meta.stage).toBe("DRAFT");
    expect(r.body!.meta.owner).not.toBe("Evil Override");
    expect(
      warnings(r.issues).some(
        (i) => i.code === "DUPLICATE_LABEL" && i.path === "section.5",
      ),
    ).toBe(true);
  });

  it("a box-name cell matching several canonical boxes warns AMBIGUOUS_BOX", () => {
    const md = MINIMAL.replace(
      "| Kỳ vọng & Phản hồi | c1 |",
      "| Kỳ vọng & Phản hồi + Công cụ & Nguồn lực | c1 |",
    );
    const r = parseMarkdown(md);
    expect(
      warnings(r.issues).some((i) => i.code === "AMBIGUOUS_BOX"),
    ).toBe(true);
    // first canonical hit wins; the row content is still preserved
    expect(r.body!.boxes[0]!.condition).toBe("c1");
  });
});
