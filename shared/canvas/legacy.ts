import { z } from "zod";
import {
  blankAction,
  blankBehavior,
  blankBox,
  blankObserved,
  blankOutput,
  blankPlanRow,
  blankReview,
  newId,
} from "./defaults.js";
import {
  ACTION_STATUSES,
  BUILD_MODES,
  CANVAS_BUSINESS_SCHEMA,
  CANVAS_PAYLOAD_VERSION,
  CANVAS_STAGES,
  CONFIDENCE_LEVELS,
  CanvasBodySchema,
  EVIDENCE_LAYERS,
  GAP_LEVELS,
  PRIORITY_LEVELS,
  REVIEW_DECISIONS,
  SIX_BOXES,
  type CanvasBody,
} from "./schema.js";

/**
 * Adapter: legacy demo snapshot (assets/data.js `CANVAS.*.versions[]` record)
 * → canonical CanvasBody.
 *
 * Contract (spec §5.1):
 *  - Never fabricate a body from a brief-only record — `{body:null, warnings}`.
 *  - Field map: cur→current, tgt→target, due→deadline (kr/outputs verbatim
 *    free text; actions/plan/observed/reviews dates normalized to ISO),
 *    beh→behavior, own→assignee_label, sup→supporter_label, risks[]→"\n".
 *  - Every dropped/renamed/failed value produces a warning — nothing silent.
 *  - boxes[].beh (a behavior *name*) resolves to behavior_id by exact match;
 *    unresolvable → null ("Cần xác nhận") + warning, never a guess.
 */

export interface LegacyImport {
  body: CanvasBody | null;
  warnings: string[];
}

type Rec = Record<string, unknown>;

/** Bookkeeping/identity keys the server owns — recognized, never imported. */
const KNOWN_KEYS = new Set([
  "id",
  "personId",
  "name",
  "v",
  "week",
  "date",
  "stage",
  "mode",
  "change",
  "owner",
  "brief",
  "goal",
  "context",
  "kr",
  "outputs",
  "direction",
  "logic",
  "behaviors",
  "boxes",
  "actions",
  "risks",
  "plan",
  "observed",
  "reviews",
]);

/** Keys that carry canvas content — a record with none is not a snapshot. */
const CONTENT_KEYS = [
  "goal",
  "context",
  "kr",
  "outputs",
  "direction",
  "logic",
  "behaviors",
  "boxes",
  "actions",
  "risks",
  "plan",
  "observed",
  "reviews",
] as const;

/** Known abbreviated keys per legacy row/object shape. */
const ROW_KEYS: Record<string, readonly string[]> = {
  kr: ["metric", "cur", "tgt", "due", "cs"],
  outputs: ["name", "cur", "tgt", "due", "cs"],
  behaviors: ["actor", "beh", "ctx", "out", "sign", "freq"],
  boxes: ["cond", "ev", "gap", "pri", "beh", "act", "own"],
  actions: ["act", "start", "due", "own", "sup", "cri", "st", "risk"],
  plan: ["date", "layer", "metric", "base", "tgt", "src", "col", "ver"],
  observed: ["date", "layer", "val", "src", "conf", "learn", "dec", "ver"],
  reviews: ["cp", "date", "ver", "be", "oe", "re", "ok", "no", "ln"],
};

const ISO_DATE = z.iso.date();

/** Verbatim text: strings pass through untouched; other primitives warn. */
function asText(v: unknown, ctx: string, warnings: string[]): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") {
    warnings.push(
      `${ctx}: giá trị ${JSON.stringify(v)} không phải chuỗi — đã ép thành chuỗi, kiểm tra lại.`,
    );
    return String(v);
  }
  warnings.push(`${ctx}: giá trị có cấu trúc không import được — để trống.`);
  return "";
}

/** Blankable enum: blank stays "", anything else must match exactly. */
function asEnumOpt<T extends readonly string[]>(
  v: unknown,
  options: T,
  ctx: string,
  warnings: string[],
): T[number] | "" {
  const s = asText(v, ctx, warnings).trim();
  if (s === "") return "";
  if ((options as readonly string[]).includes(s)) return s as T[number];
  warnings.push(
    `${ctx}: giá trị "${s}" không thuộc danh sách chuẩn (${options.join(" / ")}) — để trống, chọn lại.`,
  );
  return "";
}

/** Required enum: invalid OR absent/blank values warn and fall back
 *  explicitly — a silently defaulted stage/status would be a silent drop. */
function asEnumReq<T extends readonly string[]>(
  v: unknown,
  options: T,
  fallback: T[number],
  ctx: string,
  warnings: string[],
): T[number] {
  if (v == null || (typeof v === "string" && v.trim() === "")) {
    warnings.push(`${ctx}: thiếu giá trị — đặt "${fallback}", kiểm tra lại.`);
    return fallback;
  }
  const s = asText(v, ctx, warnings).trim();
  if ((options as readonly string[]).includes(s)) return s as T[number];
  warnings.push(
    `${ctx}: giá trị "${s}" không thuộc danh sách chuẩn (${options.join(" / ")}) — đặt "${fallback}".`,
  );
  return fallback;
}

/**
 * Date-typed fields: an ISO YYYY-MM-DD candidate must be a real calendar
 * date (z.iso.date() — "2026-13-45" warns and blanks); DD/MM/YYYY is
 * normalized then validated the same way. An ISO substring embedded in
 * other text is kept but warned — the dropped text is never silent.
 * Anything else warns and blanks: a wrong-shaped date must never flow into
 * a body the schema would reject.
 */
function asIsoDate(v: unknown, ctx: string, warnings: string[]): string {
  const s = asText(v, ctx, warnings).trim();
  if (s === "") return "";
  const iso = s.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) {
    if (ISO_DATE.safeParse(iso[0]).success) {
      if (iso[0] !== s) {
        warnings.push(
          `${ctx}: ngày "${s}" chứa text ngoài phần ISO — giữ "${iso[0]}", phần còn lại bị lược, kiểm tra lại.`,
        );
      }
      return iso[0];
    }
    warnings.push(
      `${ctx}: ngày "${iso[0]}" trong "${s}" không phải ngày lịch thật — để trống.`,
    );
    return "";
  }
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const candidate = `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
    if (ISO_DATE.safeParse(candidate).success) return candidate;
  }
  warnings.push(`${ctx}: không nhận diện được ngày "${s}" — để trống.`);
  return "";
}

function isRec(v: unknown): v is Rec {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function warnUnknownKeys(
  r: Rec,
  known: readonly string[],
  ctx: string,
  warnings: string[],
): void {
  for (const k of Object.keys(r)) {
    if (!known.includes(k)) {
      warnings.push(`${ctx}: khóa lạ "${k}" — không import, kiểm tra tay.`);
    }
  }
}

export function fromLegacy(raw: unknown): LegacyImport {
  const warnings: string[] = [];
  if (!isRec(raw)) {
    return {
      body: null,
      warnings: ["Record legacy không phải object — bỏ qua, không import."],
    };
  }
  const rec = raw;
  const label =
    typeof rec.name === "string" && rec.name.trim() !== ""
      ? rec.name
      : typeof rec.v === "string" && rec.v.trim() !== ""
        ? `${rec.v} (${typeof rec.week === "string" ? rec.week : "?"})`
        : "(không tên)";

  warnUnknownKeys(rec, [...KNOWN_KEYS], `"${label}"`, warnings);

  const isBrief = rec.brief === true;
  const hasContent = CONTENT_KEYS.some((k) => rec[k] != null);
  if (isBrief || !hasContent) {
    warnings.push(
      isBrief
        ? `"${label}": bản brief (chỉ tóm tắt thay đổi) — không có snapshot nội dung; KHÔNG dựng canvas, ghi vào migration notes.`
        : `"${label}": không có mục nội dung nào (goal/kr/boxes/…) — không phải snapshot đầy đủ; KHÔNG dựng canvas.`,
    );
    return { body: null, warnings };
  }

  // Missing content sections warn once here; mappers below blank-fill them.
  for (const k of CONTENT_KEYS) {
    if (rec[k] == null) {
      warnings.push(`"${label}": thiếu mục "${k}" — phần này để trống, điền tay lại.`);
    }
  }

  /** Rows of a list section; null when the section is absent/malformed. */
  const rowsOf = (key: keyof typeof ROW_KEYS): Rec[] | null => {
    const v = rec[key];
    if (v == null) return null; // already warned above
    if (!Array.isArray(v)) {
      warnings.push(`"${label}".${key}: không phải mảng — phần này để trống, điền tay lại.`);
      return null;
    }
    return v.flatMap((row, i) => {
      if (isRec(row)) {
        warnUnknownKeys(row, ROW_KEYS[key], `"${label}".${key}[${i}]`, warnings);
        return [row];
      }
      warnings.push(`"${label}".${key}[${i}]: dòng không phải object — bỏ qua.`);
      return [];
    });
  };

  const krRaw = rec.kr;
  const kr: CanvasBody["kr"] = isRec(krRaw)
    ? (() => {
        warnUnknownKeys(krRaw, ROW_KEYS.kr, `"${label}".kr`, warnings);
        return {
          metric: asText(krRaw.metric, `"${label}".kr.metric`, warnings),
          current: asText(krRaw.cur, `"${label}".kr.cur`, warnings),
          target: asText(krRaw.tgt, `"${label}".kr.tgt`, warnings),
          // free text in the editor — preserved verbatim, never normalized
          deadline: asText(krRaw.due, `"${label}".kr.due`, warnings),
          cs: asText(krRaw.cs, `"${label}".kr.cs`, warnings),
        };
      })()
    : krRaw == null
      ? { metric: "", current: "", target: "", deadline: "", cs: "" }
      : (() => {
          warnings.push(`"${label}".kr: không phải object — để trống.`);
          return { metric: "", current: "", target: "", deadline: "", cs: "" };
        })();

  const outputs: CanvasBody["outputs"] = (() => {
    const rows = rowsOf("outputs");
    if (rows === null) return [blankOutput()];
    let kept = rows;
    if (rows.length > 3) {
      warnings.push(
        `"${label}".outputs: ${rows.length} dòng vượt giới hạn schema (tối đa 3) — giữ 3 dòng đầu, phần còn lại bị lược, kiểm tra lại.`,
      );
      kept = rows.slice(0, 3);
    }
    return kept.map((r, i) => ({
      id: newId(),
      name: asText(r.name, `"${label}".outputs[${i}].name`, warnings),
      current: asText(r.cur, `"${label}".outputs[${i}].cur`, warnings),
      target: asText(r.tgt, `"${label}".outputs[${i}].tgt`, warnings),
      deadline: asText(r.due, `"${label}".outputs[${i}].due`, warnings),
      cs: asText(r.cs, `"${label}".outputs[${i}].cs`, warnings),
    }));
  })();

  const behaviors: CanvasBody["behaviors"] = (() => {
    const rows = rowsOf("behaviors");
    if (rows === null) return [blankBehavior(), blankBehavior()];
    let kept = rows;
    if (rows.length > 5) {
      warnings.push(
        `"${label}".behaviors: ${rows.length} dòng vượt giới hạn schema (tối đa 5) — giữ 5 dòng đầu, phần còn lại bị lược, kiểm tra lại.`,
      );
      kept = rows.slice(0, 5);
    }
    return kept.map((r, i) => ({
      id: newId(),
      actor: asText(r.actor, `"${label}".behaviors[${i}].actor`, warnings),
      behavior: asText(r.beh, `"${label}".behaviors[${i}].beh`, warnings),
      context: asText(r.ctx, `"${label}".behaviors[${i}].ctx`, warnings),
      outputs: asText(r.out, `"${label}".behaviors[${i}].out`, warnings),
      signal: asText(r.sign, `"${label}".behaviors[${i}].sign`, warnings),
      freq: asText(r.freq, `"${label}".behaviors[${i}].freq`, warnings),
    }));
  })();

  // name → id resolution for boxes[].beh; first exact match wins (same as
  // behaviors.find semantics the legacy UI relied on).
  const behaviorIdByName = new Map<string, string>();
  for (const b of behaviors) {
    if (b.behavior !== "" && !behaviorIdByName.has(b.behavior)) {
      behaviorIdByName.set(b.behavior, b.id);
    }
  }

  const boxes: CanvasBody["boxes"] = (() => {
    const rows = rowsOf("boxes");
    if (rows !== null && rows.length > SIX_BOXES.length) {
      warnings.push(
        `"${label}".boxes: ${rows.length} dòng > ${SIX_BOXES.length} box chuẩn — các dòng cuối bị bỏ qua.`,
      );
    }
    return SIX_BOXES.map((box, i) => {
      const r = rows?.[i];
      if (!r) {
        if (rows !== null) {
          warnings.push(
            `"${label}".boxes[${i}]: thiếu dòng cho box "${box.split(" | ")[0]}" — tạo dòng trống.`,
          );
        }
        return blankBox(box);
      }
      // Verbatim name match — no trimming/folding; ambiguous or unknown
      // names warn and resolve to null rather than guessing (spec §5.1).
      const behName = asText(r.beh, `"${label}".boxes[${i}].beh`, warnings);
      let behaviorId: string | null = null;
      if (behName.trim() !== "") {
        const hit = behaviorIdByName.get(behName);
        if (hit) {
          behaviorId = hit;
        } else {
          warnings.push(
            `"${label}".boxes[${i}].beh: hành vi "${behName}" không khớp Lever Behaviors — để null (cần xác nhận lại).`,
          );
        }
      }
      return {
        id: newId(),
        box,
        condition: asText(r.cond, `"${label}".boxes[${i}].cond`, warnings),
        evidence: asText(r.ev, `"${label}".boxes[${i}].ev`, warnings),
        gap: asEnumOpt(r.gap, GAP_LEVELS, `"${label}".boxes[${i}].gap`, warnings),
        priority: asEnumOpt(
          r.pri,
          PRIORITY_LEVELS,
          `"${label}".boxes[${i}].pri`,
          warnings,
        ),
        behavior_id: behaviorId,
        action: asText(r.act, `"${label}".boxes[${i}].act`, warnings),
        assignee_label: asText(r.own, `"${label}".boxes[${i}].own`, warnings),
      };
    });
  })();

  const actions: CanvasBody["actions"] = (() => {
    const rows = rowsOf("actions");
    if (rows === null) return [blankAction()];
    return rows.map((r, i) => ({
      id: newId(),
      action: asText(r.act, `"${label}".actions[${i}].act`, warnings),
      start: asIsoDate(r.start, `"${label}".actions[${i}].start`, warnings),
      deadline: asIsoDate(r.due, `"${label}".actions[${i}].due`, warnings),
      assignee_label: asText(r.own, `"${label}".actions[${i}].own`, warnings),
      supporter_label: asText(r.sup, `"${label}".actions[${i}].sup`, warnings),
      criteria: asText(r.cri, `"${label}".actions[${i}].cri`, warnings),
      status: asEnumReq(
        r.st,
        ACTION_STATUSES,
        "Chưa bắt đầu",
        `"${label}".actions[${i}].st`,
        warnings,
      ),
      risk: asText(r.risk, `"${label}".actions[${i}].risk`, warnings),
    }));
  })();

  const risks: string = (() => {
    const v = rec.risks;
    if (Array.isArray(v)) {
      return v
        .map((x, i) => asText(x, `"${label}".risks[${i}]`, warnings))
        .join("\n");
    }
    return asText(v, `"${label}".risks`, warnings);
  })();

  const plan: CanvasBody["plan"] = (() => {
    const rows = rowsOf("plan");
    if (rows === null) {
      return [blankPlanRow("BEHAVIOR"), blankPlanRow("OUTPUT"), blankPlanRow("RESULT")];
    }
    return rows.map((r, i) => ({
      id: newId(),
      date: asIsoDate(r.date, `"${label}".plan[${i}].date`, warnings),
      layer: asEnumOpt(r.layer, EVIDENCE_LAYERS, `"${label}".plan[${i}].layer`, warnings),
      metric: asText(r.metric, `"${label}".plan[${i}].metric`, warnings),
      baseline: asText(r.base, `"${label}".plan[${i}].base`, warnings),
      target: asText(r.tgt, `"${label}".plan[${i}].tgt`, warnings),
      source: asText(r.src, `"${label}".plan[${i}].src`, warnings),
      collector: asText(r.col, `"${label}".plan[${i}].col`, warnings),
      verifier: asText(r.ver, `"${label}".plan[${i}].ver`, warnings),
    }));
  })();

  const observed: CanvasBody["observed"] = (() => {
    const rows = rowsOf("observed");
    if (rows === null) return [blankObserved()];
    return rows.map((r, i) => ({
      id: newId(),
      date: asIsoDate(r.date, `"${label}".observed[${i}].date`, warnings),
      layer: asEnumOpt(
        r.layer,
        EVIDENCE_LAYERS,
        `"${label}".observed[${i}].layer`,
        warnings,
      ),
      value: asText(r.val, `"${label}".observed[${i}].val`, warnings),
      source: asText(r.src, `"${label}".observed[${i}].src`, warnings),
      confidence: asEnumOpt(
        r.conf,
        CONFIDENCE_LEVELS,
        `"${label}".observed[${i}].conf`,
        warnings,
      ),
      learning: asText(r.learn, `"${label}".observed[${i}].learn`, warnings),
      decision: asEnumOpt(
        r.dec,
        REVIEW_DECISIONS,
        `"${label}".observed[${i}].dec`,
        warnings,
      ),
      verifier: asText(r.ver, `"${label}".observed[${i}].ver`, warnings),
    }));
  })();

  const reviews: CanvasBody["reviews"] = (() => {
    const rows = rowsOf("reviews");
    if (rows === null) {
      return [blankReview("Sau 7 ngày"), blankReview("Sau 2–4 tuần")];
    }
    return rows.map((r, i) => ({
      id: newId(),
      checkpoint: asText(r.cp, `"${label}".reviews[${i}].cp`, warnings),
      date: asIsoDate(r.date, `"${label}".reviews[${i}].date`, warnings),
      behavior_evidence: asText(r.be, `"${label}".reviews[${i}].be`, warnings),
      output_evidence: asText(r.oe, `"${label}".reviews[${i}].oe`, warnings),
      result_evidence: asText(r.re, `"${label}".reviews[${i}].re`, warnings),
      works: asText(r.ok, `"${label}".reviews[${i}].ok`, warnings),
      not_works: asText(r.no, `"${label}".reviews[${i}].no`, warnings),
      learning: asText(r.ln, `"${label}".reviews[${i}].ln`, warnings),
      verifier: asText(r.ver, `"${label}".reviews[${i}].ver`, warnings),
    }));
  })();

  const body: CanvasBody = {
    schema_version: CANVAS_PAYLOAD_VERSION,
    meta: {
      title: asText(rec.name, `"${label}".name`, warnings),
      owner: asText(rec.owner, `"${label}".owner`, warnings),
      stage: asEnumReq(rec.stage, CANVAS_STAGES, "DRAFT", `"${label}".stage`, warnings),
      mode: asEnumReq(rec.mode, BUILD_MODES, "GUIDED", `"${label}".mode`, warnings),
      updated: asIsoDate(rec.date, `"${label}".date`, warnings),
      schema: CANVAS_BUSINESS_SCHEMA,
    },
    goal: {
      statement: asText(rec.goal, `"${label}".goal`, warnings),
      context: asText(rec.context, `"${label}".context`, warnings),
    },
    kr,
    outputs,
    solution: {
      direction: asText(rec.direction, `"${label}".direction`, warnings),
      logic: asText(rec.logic, `"${label}".logic`, warnings),
    },
    behaviors,
    boxes,
    actions,
    risks,
    plan,
    observed,
    reviews,
  };

  // Belt-and-suspenders: the assembled body must satisfy CanvasBodySchema.
  // If any coercion above ever slips an invalid value through, report the
  // schema issues as warnings and refuse the body instead of returning a
  // payload the schema would reject downstream.
  const gate = CanvasBodySchema.safeParse(body);
  if (!gate.success) {
    const detail = gate.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join(" | ");
    warnings.push(
      `"${label}": body dựng xong không đạt CanvasBodySchema — KHÔNG trả body. Chi tiết: ${detail}`,
    );
    return { body: null, warnings };
  }

  return { body, warnings };
}
