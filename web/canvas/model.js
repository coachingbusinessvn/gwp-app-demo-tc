/**
 * web/canvas/model.js — canonical canvas model for the browser editor
 * (task 2.5).
 *
 * Plain-JS port of shared/canvas/{schema,defaults,legacy,markdown}.ts:
 * the browser cannot import the TS sources and the public build ships
 * only static files, so this module re-declares the field mapping.
 * DIVERGENCE RISK: when the canonical schema changes, update this file
 * AND the shared TS sources together. The server stays authoritative —
 * every body is re-validated draft-mode on save and publish-mode on
 * publish, so a divergence fails closed as a 400, never a silent write.
 *
 * Canonical field names (schema_version 1):
 *   meta{title,owner,stage,mode,updated,schema}, goal{statement,context},
 *   kr{metric,current,target,deadline,cs}, outputs[]{id,name,current,
 *   target,deadline,cs}, solution{direction,logic}, behaviors[]{id,actor,
 *   behavior,context,outputs,signal,freq}, boxes[]{id,box,condition,
 *   evidence,gap,priority,behavior_id,action,assignee_label,
 *   assignee_user_id?}, actions[]{id,action,start,deadline,assignee_label,
 *   assignee_user_id?,supporter_label,criteria,status,risk}, risks,
 *   plan[]{id,date,layer,metric,baseline,target,source,collector,
 *   verifier}, observed[]{id,date,layer,value,source,confidence,learning,
 *   decision,verifier,measurement?}, reviews[]{id,checkpoint,date,
 *   behavior_evidence,output_evidence,result_evidence,works,not_works,
 *   learning,verifier}.
 *
 * Legacy editor shapes are accepted on IMPORT ONLY (sanitizeBody): row
 * ids are generated, `behavior` name strings resolve to behavior_id,
 * owner/supporter→assignee_label/supporter_label and camelCase review
 * keys → snake_case — same mapping as shared/canvas/legacy.ts.
 */

export const CANVAS_PAYLOAD_VERSION = 1;
export const CANVAS_BUSINESS_SCHEMA = "3.0";

export const ENUMS = {
  stages: ["DRAFT", "PILOTING", "VALIDATED"],
  modes: ["GUIDED", "RAPID_DRAFT"],
  gap: ["Cao", "Trung bình", "Thấp"],
  priority: ["Cao", "Trung bình", "Thấp", "Chưa xác định"],
  status: [
    "Chưa bắt đầu",
    "Đang thực hiện",
    "Hoàn thành",
    "Tạm dừng",
    "Cần hỗ trợ",
  ],
  layer: ["BEHAVIOR", "OUTPUT", "RESULT"],
  confidence: ["HIGH", "MEDIUM", "LOW"],
  decision: ["CONTINUE", "ADJUST", "STOP"],
};

export const SIX_BOXES = [
  "Kỳ vọng & Phản hồi | Expectations & Feedback",
  "Công cụ & Nguồn lực | Tools & Resources",
  "Hệ quả & Ghi nhận | Consequences & Recognition",
  "Kiến thức & Kỹ năng | Knowledge & Skills",
  "Vai trò & Quyền hạn | Role & Authority",
  "Động lực & Ưu tiên | Motivation & Priorities",
];

export const STEPS = [
  { vn: "MỤC TIÊU", en: "1. GOAL", q: "Chúng ta muốn đạt điều gì?" },
  {
    vn: "KẾT QUẢ CHÍNH + ĐẦU RA / CS",
    en: "2. KEY RESULT + CRITICAL OUTPUTS / CS",
    q: "Kết quả và đầu ra nào sẽ tạo ra tác động?",
  },
  {
    vn: "HƯỚNG GIẢI PHÁP + HÀNH VI ĐÒN BẨY",
    en: "3. SOLUTION DIRECTION + LEVER BEHAVIORS",
    q: "Hướng nào tạo tác động lớn nhất? Hành vi nào cần xuất hiện?",
  },
  {
    vn: "ĐIỀU KIỆN TẠO HÀNH VI",
    en: "4. CONDITIONS (6 BOXES)",
    q: "Những điều kiện nào cần có để hành vi xảy ra?",
  },
  {
    vn: "KẾ HOẠCH THỬ NGHIỆM",
    en: "5. ACTION EXPERIMENT",
    q: "Chúng ta sẽ làm gì, với ai và khi nào?",
  },
  {
    vn: "BẰNG CHỨNG THEO DÕI",
    en: "6. FOLLOW-UP EVIDENCE",
    q: "Làm thế nào để biết nó đang hiệu quả?",
  },
];

export const GUIDE = [
  {
    muctieu: "Làm rõ mục tiêu tổng thể cần đạt.",
    cauhoi:
      "Chúng ta thực sự muốn đạt điều gì? Mục tiêu này quan trọng với ai và trong bối cảnh nào?",
    ketqua:
      "Một Goal có ý nghĩa, phạm vi rõ, không phải danh sách hoạt động.",
    loi: "Viết mục tiêu thành một chuỗi việc phải làm.",
    chuan:
      "Diễn đạt kết quả cuối cùng mong muốn và gắn với bối cảnh kinh doanh.",
  },
  {
    muctieu:
      "Lượng hóa kết quả và xác định các đầu ra công việc trực tiếp tạo ra kết quả.",
    cauhoi:
      "Con số nào chứng minh Goal đã đạt? Những đầu ra nào đang trực tiếp quyết định con số đó?",
    ketqua:
      "Key Result có mức hiện tại, mức mục tiêu, thời hạn; 1–3 Critical Outputs có tiêu chuẩn chất lượng.",
    loi: "Chọn KPI không liên quan trực tiếp; nhầm Output với Activity.",
    chuan: "Đo được; quan sát được; có mối liên hệ logic với Goal.",
  },
  {
    muctieu:
      "Chọn hướng tạo hiệu suất và xác định những hành vi có tính đòn bẩy.",
    cauhoi:
      "Hướng nào có khả năng tác động đồng thời tới các Output? Bằng chứng nào cho thấy hướng đó hợp lý? Nếu chọn hướng này, đội phải làm khác điều gì?",
    ketqua:
      "Một Solution Direction được kiểm chứng; 2–5 Lever Behaviors cụ thể và quan sát được.",
    loi: "Nhảy thẳng vào danh sách hành động; gọi tên công cụ như giải pháp; chọn quá nhiều hành vi.",
    chuan:
      "Solution Direction = Động từ định hướng + Điểm tập trung + Key Result; hành vi gắn trực tiếp với Output.",
  },
  {
    muctieu:
      "Xác định các điều kiện đang thúc đẩy hoặc cản trở hành vi đòn bẩy.",
    cauhoi:
      "Điều gì cần có để hành vi xảy ra ổn định? Khoảng cách nằm ở môi trường hay cá nhân?",
    ketqua:
      "Các điều kiện cần và khoảng cách theo 6 Boxes, có bằng chứng cho từng khoảng cách quan trọng.",
    loi: "Đổ lỗi ngay cho năng lực hoặc động lực cá nhân; liệt kê điều kiện chung chung.",
    chuan: "Mỗi condition gắn với một Lever Behavior, có hiện trạng và bằng chứng.",
  },
  {
    muctieu:
      "Biến điểm đòn bẩy thành thử nghiệm nhỏ, nhanh, có thể đo và điều chỉnh.",
    cauhoi:
      "Trong 7–14 ngày, thử nghiệm nhỏ nhất nào có thể kiểm chứng giả thuyết? Ai làm, khi nào, với hỗ trợ gì?",
    ketqua:
      "Hành động, Owner, Supporter, thời gian, tiêu chí thành công và rủi ro được xác định.",
    loi: "Triển khai diện rộng ngay; không có người chịu trách nhiệm; hành động quá lớn.",
    chuan: "Ngắn hạn, khả thi, đo được, có quyền sở hữu rõ và có thể điều chỉnh.",
  },
  {
    muctieu: "Theo dõi bằng chứng ở ba tầng và tạo vòng lặp học hỏi.",
    cauhoi:
      "Bằng chứng nào cho thấy hành vi đã thay đổi, Output đã cải thiện và Key Result đang tiến triển? Khi nào Review?",
    ketqua:
      "Behavior Evidence, Output Evidence, Result Evidence; lịch Review; bài học và quyết định tiếp theo.",
    loi: "Chỉ hỏi cảm nhận; chỉ nhìn kết quả cuối cùng; không có mốc Review.",
    chuan: "Có dữ liệu ở ba tầng, có người xác nhận và có quyết định điều chỉnh.",
  },
];

export const STAGE_NOTES = {
  DRAFT:
    "Stage DRAFT: chỉ cần lập Measurement Plan; các dòng Observed Evidence sẽ được xuất là “TBD” (chưa có quan sát thực tế). Kế hoạch thử nghiệm là đề xuất, chưa phải đã hoàn thành.",
  PILOTING:
    "Stage PILOTING: cung cấp Measurement Plan kèm Observed Evidence tạm thời được ghi chú rõ. Bằng chứng một phần chưa đủ để coi canvas là VALIDATED.",
  VALIDATED:
    "Stage VALIDATED: bắt buộc có quan sát thực tế kèm ngày, nguồn trích dẫn, bài học, quyết định và người xác nhận. Chỉ giá trị kế hoạch thì không đủ.",
};

export const LIMITS = { outputs: [1, 3], behaviors: [2, 5] };

// Must match the server's strictness — zod's z.string().uuid() enforces
// the RFC4122 version nibble ([1-8]) and variant ([89ab]) plus nil/max;
// a looser check would preserve ids the strict save then rejects.
const UUID_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
export const newId = () => crypto.randomUUID();
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

/* ================= Blank canonical factories ================= */

export function blankOutput() {
  return { id: newId(), name: "", current: "", target: "", deadline: "", cs: "" };
}
export function blankBehavior() {
  return {
    id: newId(),
    actor: "",
    behavior: "",
    context: "",
    outputs: "",
    signal: "",
    freq: "",
  };
}
export function blankBox(box) {
  return {
    id: newId(),
    box: box ?? "",
    condition: "",
    evidence: "",
    gap: "",
    priority: "",
    behavior_id: null,
    action: "",
    assignee_label: "",
  };
}
export function blankAction() {
  return {
    id: newId(),
    action: "",
    start: "",
    deadline: "",
    assignee_label: "",
    supporter_label: "",
    criteria: "",
    status: "Chưa bắt đầu",
    risk: "",
  };
}
export function blankPlanRow(layer) {
  return {
    id: newId(),
    date: "",
    layer: layer ?? "",
    metric: "",
    baseline: "",
    target: "",
    source: "",
    collector: "",
    verifier: "",
  };
}
export function blankObserved() {
  return {
    id: newId(),
    date: "",
    layer: "",
    value: "",
    source: "",
    confidence: "",
    learning: "",
    decision: "",
    verifier: "",
  };
}
export function blankReview(checkpoint) {
  return {
    id: newId(),
    checkpoint: checkpoint ?? "",
    date: "",
    behavior_evidence: "",
    output_evidence: "",
    result_evidence: "",
    works: "",
    not_works: "",
    learning: "",
    verifier: "",
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export function blankBody() {
  return {
    schema_version: CANVAS_PAYLOAD_VERSION,
    meta: {
      title: "",
      owner: "",
      stage: "DRAFT",
      mode: "GUIDED",
      updated: today(),
      schema: CANVAS_BUSINESS_SCHEMA,
    },
    goal: { statement: "", context: "" },
    kr: { metric: "", current: "", target: "", deadline: "", cs: "" },
    outputs: [blankOutput()],
    solution: { direction: "", logic: "" },
    behaviors: [blankBehavior(), blankBehavior()],
    boxes: SIX_BOXES.map(blankBox),
    actions: [blankAction()],
    risks: "",
    plan: [blankPlanRow("BEHAVIOR"), blankPlanRow("OUTPUT"), blankPlanRow("RESULT")],
    observed: [blankObserved()],
    reviews: [blankReview("Sau 7 ngày"), blankReview("Sau 2–4 tuần")],
  };
}

/* ================= Small helpers ================= */

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Display name of a box's linked Lever Behavior ("" when unconfirmed). */
export function behaviorName(body, id) {
  if (!id) return "";
  const b = (body.behaviors || []).find((x) => x.id === id);
  return b ? b.behavior : "";
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** True when the body carries any user-entered content. */
export function stateHasData(body) {
  const a = clone(body);
  const b = blankBody();
  a.meta.updated = "";
  b.meta.updated = "";
  const strip = (o) =>
    JSON.stringify(o, (k, v) => (k === "id" ? undefined : v));
  return strip(a) !== strip(b);
}

/* ================= Sanitize / import (canonical + legacy shapes) ================= */

const str = (v) => (v == null ? "" : String(v));
const clean = (v) => str(v);

/**
 * Copy string fields from src onto dst. `fields` is the canonical key
 * list; `aliases[k]` is an optional legacy key consulted when the
 * canonical key is absent (owner→assignee_label, behaviorEv→
 * behavior_evidence, …). The strict server schema rejects anything the
 * adapter emits wrong — so a value that can't land in a string field
 * (objects, bad enums handled by callers) is dropped WITH a warning
 * rather than passed through to a guaranteed 400.
 */
function mergeRow(dst, src, aliases, warnings, ctx, versioned) {
  // Keys this row handled beyond dst's own shape — reported to the caller
  // so warnDroppedKeys doesn't double-report them.
  const handled = new Set();
  for (const k of Object.keys(dst)) {
    if (k === "id" || k === "box") continue;
    let v = src[k];
    if (v == null && aliases && aliases[k] != null) v = src[aliases[k]];
    if (v === undefined) continue;
    if (v === null) {
      // Explicit null is schema-valid ONLY for behavior_id (unconfirmed
      // link). On every other leaf it is malformed input — normalize to
      // the row default with a warning instead of silently absorbing it.
      if (k === "behavior_id") dst[k] = null;
      else if (versioned)
        warnings.push(`${ctx}.${k}: giá trị null không hợp lệ — đã bỏ.`);
      continue;
    }
    if (k === "behavior_id") {
      if (isUuid(v)) dst[k] = v;
      else if (versioned)
        warnings.push(`${ctx}: behavior_id không hợp lệ — đã bỏ.`);
      else dst[k] = null;
      continue;
    }
    if (typeof v === "object") {
      // Structured values belong to schema-declared extensions only
      // (observed.measurement — handled below). An object in a plain
      // string field is malformed input; silent passthrough would make
      // the next strict save fail, so drop it with a warning.
      warnings.push(`${ctx}.${k}: giá trị không phải chuỗi — đã bỏ.`);
      continue;
    }
    dst[k] = str(v);
  }
  // assignee_user_id belongs to assignee rows only (boxes + actions —
  // the row types carrying assignee_label). On other row types the strict
  // schema rejects it, so a stray value is dropped with a warning.
  const aid = src.assignee_user_id;
  if (aid !== undefined) {
    handled.add("assignee_user_id");
    if (aid === null) {
      if (versioned)
        warnings.push(`${ctx}: assignee_user_id null không hợp lệ — đã bỏ.`);
    } else if ("assignee_label" in dst) {
      if (isUuid(aid)) dst.assignee_user_id = aid;
      else warnings.push(`${ctx}: assignee_user_id không hợp lệ — đã bỏ.`);
    } else if (versioned) {
      warnings.push(`${ctx}: assignee_user_id không thuộc loại dòng này — đã bỏ.`);
    }
  }
  // Observed rows may carry the strict `measurement` extension — salvage
  // only a schema-shaped object (unknown nested keys would make the
  // strict server reject the whole save); anything else warns + drops.
  if (src.measurement !== undefined) {
    const m = src.measurement;
    handled.add("measurement");
    if (m === null) {
      if (versioned)
        warnings.push(`${ctx}: measurement null không hợp lệ — đã bỏ.`);
    } else if ("value" in dst && "confidence" in dst) {
      const mDate = str(m.date).trim();
      const ok =
        m &&
        typeof m === "object" &&
        !Array.isArray(m) &&
        isUuid(m.metricId) &&
        Number.isInteger(m.definitionRevision) &&
        m.definitionRevision > 0 &&
        ENUMS.layer.indexOf(m.layer) >= 0 &&
        isRealDate(mDate) &&
        Number.isFinite(m.value) &&
        typeof m.unit === "string" &&
        m.unit !== "" &&
        Number.isFinite(m.baseline) &&
        Number.isFinite(m.target) &&
        Object.keys(m).every((k) =>
          [
            "metricId",
            "definitionRevision",
            "layer",
            "date",
            "value",
            "unit",
            "baseline",
            "target",
          ].includes(k),
        );
      if (ok) {
        dst.measurement = {
          metricId: m.metricId,
          definitionRevision: m.definitionRevision,
          layer: m.layer,
          date: mDate,
          value: m.value,
          unit: m.unit,
          baseline: m.baseline,
          target: m.target,
        };
      } else {
        warnings.push(`${ctx}: measurement không đúng cấu trúc — đã bỏ.`);
      }
    } else if (versioned) {
      warnings.push(`${ctx}: measurement không thuộc loại dòng này — đã bỏ.`);
    }
  }
  return handled;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(v) {
  const s = str(v).trim();
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : "";
}
/** Shape AND real-calendar check — "2026-99-99" matches the regex but
 * z.iso.date() on the server rejects it, so the adapter must too. */
function isRealDate(s) {
  if (!ISO_DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
/**
 * Extract the date candidate, then drop — with a warning — anything that
 * isn't a real calendar day (the strict server would reject the save).
 */
function checkedDate(v, warnings, ctx) {
  const s = isoDate(v);
  if (s && !isRealDate(s)) {
    warnings.push(`${ctx}: ngày "${s}" không tồn tại — đã bỏ.`);
    return "";
  }
  // Supplied content that yields no ISO date at all is still a silent
  // drop — the strict server allows "" but the user's text is gone.
  if (!s && str(v).trim() !== "") {
    warnings.push(
      `${ctx}: ngày "${str(v).trim().slice(0, 60)}" không đọc được — đã bỏ.`,
    );
    return "";
  }
  return s;
}
const enumOr = (v, opts, dft) => (opts.indexOf(v) >= 0 ? v : dft);
/** enumOr + a warning on ANY normalization — a supplied invalid value
 * (including "" where the schema requires a member, e.g. actions.status)
 * must never silently become the default. Blank defaults the schema
 * accepts (enumOrBlank fields) pass through quietly since out === v. */
function enumCheck(v, opts, dft, warnings, ctx) {
  const out = enumOr(v, opts, dft);
  if (out !== v)
    warnings.push(`${ctx}: giá trị "${v}" không hợp lệ — đã để mặc định.`);
  return out;
}

/**
 * The six boxes matched by NAME — every supplied row keeps its data no
 * matter the count or order; boxes with no match stay blank. Never
 * discards a supplied box row just because the array length is off.
 * Shared by the trusted repair path and the lossy import adapter.
 */
function mergeBoxes(rawBoxes, warnings, versioned = false) {
  const raw = Array.isArray(rawBoxes) ? rawBoxes : [];
  if (versioned && rawBoxes != null && !Array.isArray(rawBoxes))
    warnings.push("boxes: không phải danh sách — đã bỏ, 6 ô để trống.");
  // Each source row may satisfy exactly ONE box — otherwise a combined
  // name like "Kỳ vọng & Phản hồi + Công cụ & Nguồn lực" matches two
  // canonical boxes and its id lands on both (duplicate_id → 400 save).
  const consumed = new Set();
  const boxName = (b) =>
    b && typeof b === "object" ? str(b.box).trim().toLowerCase() : "";
  const pick = (pred) => {
    const i = raw.findIndex(
      (b, j) => !consumed.has(j) && pred(boxName(b)),
    );
    if (i >= 0) consumed.add(i);
    return i >= 0 ? raw[i] : undefined;
  };
  const result = SIX_BOXES.map((name) => {
    const vn = name.split(" | ")[0].toLowerCase();
    const en = name.split(" | ")[1].toLowerCase();
    const full = name.toLowerCase();
    // Exact canonical-name match first (full bilingual string or either
    // half alone), then the legacy substring fallback for name variants.
    const hit =
      pick((s) => s === full || s === vn || s === en) ??
      pick((s) => s !== "" && (s.indexOf(vn) >= 0 || s.indexOf(en) >= 0));
    const b = blankBox(name);
    if (hit) {
      if (isUuid(hit.id)) b.id = hit.id;
      else if (hit.id != null && versioned)
        warnings.push(
          `boxes "${name.split(" | ")[0]}": id không hợp lệ — đã cấp id mới.`,
        );
      const handled = mergeRow(
        b,
        hit,
        { assignee_label: "owner" },
        warnings,
        `boxes "${name.split(" | ")[0]}"`,
        versioned,
      );
      b.box = name;
      if (versioned)
        warnDroppedKeys(
          hit,
          b,
          warnings,
          `boxes "${name.split(" | ")[0]}"`,
          handled,
        );
      // Legacy rows carry the behavior NAME (never an id).
      if (!b.behavior_id && typeof hit.behavior === "string") {
        b._legacyBehaviorName = hit.behavior;
      }
    }
    return b;
  });
  // Every supplied row is accounted for: a box that matched nothing
  // (unknown name, surplus 7th row, non-object) is a silent drop unless
  // it is named in the warnings.
  raw.forEach((b, j) => {
    if (consumed.has(j)) return;
    if (b && typeof b === "object") {
      const label = str(b.box).trim();
      warnings.push(
        `boxes: ô "${label ? label.slice(0, 60) : "(không tên)"}" không khớp 6 ô chuẩn — đã bỏ.`,
      );
    } else {
      warnings.push(`boxes[${j}]: dòng không phải đối tượng — đã bỏ.`);
    }
  });
  return result;
}

/** Keys a versioned row may legitimately carry beyond the blank row's —
 * the legacy behavior-name shim only; absorbed extensions
 * (assignee_user_id, measurement) land IN dst and so never reach the
 * dropped-key check. */
const ROW_EXTRA_KEYS = new Set(["behavior", "_legacyBehaviorName"]);

/**
 * Versioned input claims canonical shape — warn when a source row carries
 * keys the schema doesn't know (they're dropped, and the strict server
 * would reject them anyway). Legacy inputs skip this: their key names are
 * intentionally different and handled by aliases.
 */
function warnDroppedKeys(src, dst, warnings, ctx, handled) {
  const known = new Set(Object.keys(dst));
  const dropped = Object.keys(src).filter(
    (k) =>
      !known.has(k) && !ROW_EXTRA_KEYS.has(k) && !(handled && handled.has(k)),
  );
  if (dropped.length)
    warnings.push(`${ctx}: trường không thuộc schema đã bỏ: ${dropped.join(", ")}.`);
}

/**
 * A canonical body (schema_version === CANVAS_PAYLOAD_VERSION) loaded
 * from the server is already strict-validated — the editor must not
 * reinterpret it: every field (including non-editable extensions like
 * observed[].measurement and assignee_user_id) and every row id
 * round-trips verbatim. This path only deep-clones and repairs the
 * structural minimum renderers need: non-object rows are dropped, absent
 * containers become [], a malformed boxes array is salvaged by name —
 * nothing is topped up with phantom rows and no supplied data is reset.
 * Callers must opt in via sanitizeBody's `trusted` flag; anything else
 * takes the lossy adapter below.
 */
function canonicalBody(input, warnings) {
  const st = clone(input);
  const blank = blankBody();
  for (const k of ["meta", "goal", "kr", "solution"]) {
    if (!st[k] || typeof st[k] !== "object") st[k] = blank[k];
    else st[k] = { ...blank[k], ...st[k] };
  }
  for (const k of [
    "outputs",
    "behaviors",
    "actions",
    "plan",
    "observed",
    "reviews",
  ]) {
    // Lossless: an absent/non-array container becomes [] — never topped
    // up with blank rows (that would write phantom rows back on save).
    if (!Array.isArray(st[k])) st[k] = [];
    else st[k] = st[k].filter((row) => row && typeof row === "object");
    for (const row of st[k]) {
      // Row ids are required by the editor's keyed rendering — assign
      // one only when genuinely absent/invalid; never regenerate.
      if (!isUuid(row.id)) row.id = newId();
    }
  }
  // The renderer needs exactly six boxes — salvage by name, never reset.
  if (!Array.isArray(st.boxes) || st.boxes.length !== 6) {
    st.boxes = mergeBoxes(st.boxes, warnings, true);
    for (const b of st.boxes) delete b._legacyBehaviorName;
  } else {
    for (const row of st.boxes) {
      if (row && typeof row === "object" && !isUuid(row.id))
        row.id = newId();
    }
  }
  if (typeof st.risks !== "string") st.risks = str(st.risks);
  st.schema_version = CANVAS_PAYLOAD_VERSION;
  return st;
}

/**
 * Coerce an arbitrary parsed object into a canonical body. Server-loaded
 * canonical bodies (trusted=true) round-trips verbatim; imports — even
 * ones claiming schema_version — are coerced: ids preserved when valid,
 * legacy aliases resolved, malformed shapes salvaged or dropped WITH a
 * warning, so the strict server never rejects the next save. Returns a
 * fresh blankBody() when input is not an object.
 */
export function sanitizeBody(input, warnings = [], trusted = false) {
  const p = input && typeof input === "object" ? input : {};
  // A saved DTO (draft/version) wraps the body — unwrap it transparently.
  if (p.body && typeof p.body === "object" && p.body.meta) {
    return sanitizeBody(p.body, warnings, trusted);
  }
  const versioned = p.schema_version === CANVAS_PAYLOAD_VERSION;
  // Only server-loaded bodies are trusted — a pasted/imported payload can
  // carry schema_version:1 while being malformed; those must flow through
  // the coercing adapter so the strict server never rejects the next save.
  if (versioned && trusted) return canonicalBody(p, warnings);
  const st = blankBody();
  const mergeObj = (dst, src, name) => {
    if (src && typeof src === "object") {
      for (const k of Object.keys(dst)) {
        if (src[k] === undefined) continue;
        if (src[k] === null) {
          // No leaf in meta/goal/kr/solution is nullable under the strict
          // schema — an explicit null is malformed input, not an absent
          // key, so it earns a warning instead of a silent default.
          if (versioned)
            warnings.push(`${name}.${k}: giá trị null không hợp lệ — đã bỏ.`);
          continue;
        }
        if (typeof src[k] === "object") {
          if (versioned)
            warnings.push(`${name}.${k}: giá trị không phải chuỗi — đã bỏ.`);
          continue;
        }
        dst[k] = str(src[k]);
      }
      if (versioned) {
        const dropped = Object.keys(src).filter(
          (k) => !(k in dst) && src[k] !== undefined,
        );
        if (dropped.length)
          warnings.push(
            `${name}: trường không thuộc schema đã bỏ: ${dropped.join(", ")}.`,
          );
      }
    } else if (src != null && versioned) {
      warnings.push(`${name}: không phải đối tượng — đã bỏ.`);
    }
  };
  mergeObj(st.meta, p.meta, "meta");
  mergeObj(st.goal, p.goal, "goal");
  mergeObj(st.kr, p.kr, "kr");
  mergeObj(st.solution, p.solution, "solution");
  if (p.risks != null) {
    if (Array.isArray(p.risks)) {
      // Legacy risks[] joins newline-separated; versioned input declaring
      // an array is off-schema but joins losslessly — warn anyway.
      if (versioned)
        warnings.push("risks: schema yêu cầu chuỗi — đã nối danh sách.");
      st.risks = p.risks.map((x) => str(x)).join("\n");
    } else if (typeof p.risks === "object") {
      if (versioned)
        warnings.push("risks: giá trị không phải chuỗi — đã bỏ.");
    } else {
      st.risks = str(p.risks);
    }
  }
  st.meta.stage = enumCheck(st.meta.stage, ENUMS.stages, "DRAFT", warnings, "meta.stage");
  st.meta.mode = enumCheck(st.meta.mode, ENUMS.modes, "GUIDED", warnings, "meta.mode");
  if (!isRealDate(st.meta.updated)) {
    if (st.meta.updated && versioned)
      warnings.push("meta.updated: ngày không hợp lệ — đã đặt hôm nay.");
    st.meta.updated = today();
  }
  if (
    versioned &&
    p.meta &&
    typeof p.meta === "object" &&
    p.meta.schema != null &&
    str(p.meta.schema) !== CANVAS_BUSINESS_SCHEMA
  ) {
    warnings.push(
      `meta.schema "${str(p.meta.schema)}" không phải ${CANVAS_BUSINESS_SCHEMA} — đã đặt lại.`,
    );
  }
  st.meta.schema = CANVAS_BUSINESS_SCHEMA;

  const mergeList = (name, maker, aliases, min, max, label, ctx) => {
    if (!Array.isArray(p[name])) {
      if (versioned && p[name] != null)
        warnings.push(`${label}: không phải danh sách — đã bỏ.`);
      return st[name];
    }
    if (!p[name].length) return st[name];
    let arr = p[name].map((row, i) => {
      const b = maker();
      if (row && typeof row === "object") {
        if (isUuid(row.id)) b.id = row.id;
        else if (row.id != null && versioned)
          warnings.push(`${ctx || label}[${i}]: id không hợp lệ — đã cấp id mới.`);
        const rowCtx = `${ctx || label}[${i}]`;
        const handled = mergeRow(b, row, aliases, warnings, rowCtx, versioned);
        if (versioned) warnDroppedKeys(row, b, warnings, rowCtx, handled);
      } else if (versioned) {
        warnings.push(`${ctx || label}[${i}]: dòng không phải đối tượng — đã bỏ.`);
      }
      return { b, src: row, i };
    });
    // A supplied row whose ONLY content was dropped as invalid (e.g. a
    // lone malformed measurement) would vanish silently in the empty-row
    // filter — name it so the drop is accounted for.
    arr = arr.filter(({ b, src, i }) => {
      const keep = Object.entries(b).some(
        ([k, v]) =>
          k !== "id" && k !== "box" && k !== "assignee_user_id" &&
          str(v).trim() !== "",
      );
      if (
        !keep &&
        versioned &&
        src &&
        typeof src === "object" &&
        Object.keys(src).length > 0
      )
        warnings.push(
          `${ctx || label}[${i}]: dòng không còn nội dung hợp lệ — đã bỏ.`,
        );
      return keep;
    });
    arr = arr.map(({ b }) => b);
    if (max && arr.length > max) {
      warnings.push(
        `${label}: vượt giới hạn schema (${max} dòng) — giữ ${max} dòng đầu.`,
      );
      arr = arr.slice(0, max);
    }
    while (arr.length < min) arr.push(maker());
    return arr.length ? arr : st[name];
  };

  st.outputs = mergeList(
    "outputs",
    blankOutput,
    null,
    LIMITS.outputs[0],
    LIMITS.outputs[1],
    "Critical Outputs",
  );
  st.behaviors = mergeList(
    "behaviors",
    blankBehavior,
    null,
    LIMITS.behaviors[0],
    LIMITS.behaviors[1],
    "Lever Behaviors",
  );
  st.actions = mergeList(
    "actions",
    blankAction,
    { assignee_label: "owner", supporter_label: "supporter" },
    1,
    0,
    "Action Experiment",
  );
  st.plan = mergeList(
    "plan",
    () => blankPlanRow(""),
    null,
    1,
    0,
    "Measurement Plan",
  );
  st.observed = mergeList(
    "observed",
    blankObserved,
    null,
    1,
    0,
    "Observed Evidence",
  );
  st.reviews = mergeList(
    "reviews",
    () => blankReview(""),
    {
      behavior_evidence: "behaviorEv",
      output_evidence: "outputEv",
      result_evidence: "resultEv",
      not_works: "notWorks",
    },
    1,
    0,
    "Lịch Review",
  );

  // 6 Boxes: always exactly the six canonical rows, matched by box name —
  // count/order anomalies salvage rather than reset supplied data.
  st.boxes = mergeBoxes(p.boxes, warnings, versioned);

  // Row ids must be unique document-wide — a duplicated id breaks keyed
  // rendering and fails the server's duplicate_id check on the next save.
  // The first row keeps the id; later duplicates are regenerated + warned.
  const seenIds = new Set();
  for (const [label, rows] of [
    ["outputs", st.outputs],
    ["behaviors", st.behaviors],
    ["boxes", st.boxes],
    ["actions", st.actions],
    ["plan", st.plan],
    ["observed", st.observed],
    ["reviews", st.reviews],
  ]) {
    rows.forEach((r, i) => {
      if (seenIds.has(r.id)) {
        r.id = newId();
        warnings.push(`${label}[${i}]: id trùng — đã cấp id mới.`);
      } else {
        seenIds.add(r.id);
      }
    });
  }

  // Resolve boxes[].behavior_id: canonical uuid → must exist in
  // behaviors[]; legacy name → first exact match wins; anything else →
  // null ("Cần xác nhận") + warning, never a guess.
  const byName = new Map();
  for (const b of st.behaviors) {
    const n = b.behavior.trim();
    if (n && !byName.has(n)) byName.set(n, b.id);
  }
  const byId = new Set(st.behaviors.map((b) => b.id));
  st.boxes.forEach((b) => {
    if (b.behavior_id) {
      if (!byId.has(b.behavior_id)) {
        warnings.push(
          `Bước 4 (“${b.box.split(" | ")[0]}”): behavior_id không tồn tại trong Lever Behaviors — để trống (cần xác nhận lại).`,
        );
        b.behavior_id = null;
      }
      return;
    }
    const legacyName = b._legacyBehaviorName;
    delete b._legacyBehaviorName;
    if (legacyName == null || legacyName.trim() === "") return;
    const hit = byName.get(legacyName.trim());
    if (hit) b.behavior_id = hit;
    else if (legacyName.trim() !== "Cần xác nhận")
      warnings.push(
        `Bước 4 (“${b.box.split(" | ")[0]}”): hành vi liên quan “${legacyName}” không khớp danh sách Lever Behaviors — để trống (cần xác nhận lại).`,
      );
  });

  st.actions.forEach((a, i) => {
    a.status = enumCheck(a.status, ENUMS.status, "Chưa bắt đầu", warnings, `actions[${i}].status`);
    a.start = checkedDate(a.start, warnings, `actions[${i}].start`);
    a.deadline = checkedDate(a.deadline, warnings, `actions[${i}].deadline`);
  });
  st.boxes.forEach((b, i) => {
    b.gap = enumCheck(b.gap, ENUMS.gap, "", warnings, `boxes[${i}].gap`);
    b.priority = enumCheck(b.priority, ENUMS.priority, "", warnings, `boxes[${i}].priority`);
  });
  st.plan.forEach((r, i) => {
    r.layer = enumCheck(r.layer, ENUMS.layer, "", warnings, `plan[${i}].layer`);
    r.date = checkedDate(r.date, warnings, `plan[${i}].date`);
  });
  st.observed.forEach((r, i) => {
    r.layer = enumCheck(r.layer, ENUMS.layer, "", warnings, `observed[${i}].layer`);
    r.confidence = enumCheck(r.confidence, ENUMS.confidence, "", warnings, `observed[${i}].confidence`);
    r.decision = enumCheck(r.decision, ENUMS.decision, "", warnings, `observed[${i}].decision`);
    r.date = checkedDate(r.date, warnings, `observed[${i}].date`);
  });
  st.reviews.forEach((r, i) => {
    r.date = checkedDate(r.date, warnings, `reviews[${i}].date`);
  });
  if (versioned) {
    // Canonical input carrying foreign keys would 400 on the next strict
    // save — they're dropped by the adapter, so say so explicitly.
    const known = new Set([...Object.keys(st), "schema_version"]);
    const dropped = Object.keys(p).filter((k) => !known.has(k));
    if (dropped.length)
      warnings.push(
        `Trường không thuộc schema đã bỏ: ${dropped.join(", ")}.`,
      );
  }
  return st;
}

/* ================= Markdown export (đúng khung gold example) ================= */

function mdCell(v) {
  return (
    str(v).trim().replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "; ") || ""
  );
}
function mdTable(headers, rows) {
  const out = [
    "| " + headers.join(" | ") + " |",
    "|" + headers.map(() => "---").join("|") + "|",
  ];
  rows.forEach((r) => out.push("| " + r.map(mdCell).join(" | ") + " |"));
  return out.join("\n");
}
/** Observed rows for export: DRAFT stage renders TBD placeholders. */
export function observedRows(body) {
  if (body.meta.stage === "DRAFT") return [Array(8).fill("TBD")];
  const rows = body.observed.filter((o) =>
    Object.entries(o).some(
      ([k, v]) => k !== "id" && k !== "measurement" && str(v).trim(),
    ),
  );
  return rows.length
    ? rows.map((o) => [
        o.date, o.layer, o.value, o.source,
        o.confidence, o.learning, o.decision, o.verifier,
      ])
    : [Array(8).fill("TBD")];
}

export function buildMarkdown(body) {
  const m = body.meta;
  const s = body;
  const title = m.title.trim() || "(chưa đặt tên)";
  const L = [];
  L.push(`# PERFORMANCE ARCHITECTURE CANVAS — ${title}`);
  L.push("");
  L.push(
    `**Canvas Stage:** ${m.stage} · **Build Mode:** ${m.mode} · **Schema Version:** ${CANVAS_BUSINESS_SCHEMA} · **Last Updated:** ${m.updated || ""} · **Migration Status:** Native v3`,
  );
  if (m.owner.trim()) L.push(`**Người lập:** ${m.owner.trim()}`);
  L.push("");
  L.push("## 1. GOAL | MỤC TIÊU");
  L.push("");
  L.push(s.goal.statement.trim() || "(chưa điền)");
  if (s.goal.context.trim()) {
    L.push("");
    L.push(`**Bối cảnh & phạm vi:** ${s.goal.context.trim()}`);
  }
  L.push("");
  L.push("## 2. KEY RESULT + CRITICAL OUTPUTS / CS");
  L.push("");
  if (s.kr.metric.trim() || s.kr.current || s.kr.target)
    L.push(
      `**Key Result:** ${s.kr.metric.trim()} tăng/đạt từ **${s.kr.current || "?"}** (hiện tại) lên **${s.kr.target || "?"}** (mục tiêu), thời hạn **${s.kr.deadline || "?"}**.`,
    );
  L.push("");
  const t2 = [
    ["Thành phần", "Loại", "Hiện tại", "Mục tiêu", "Thời hạn", "Tiêu chuẩn chất lượng (CS)"],
  ];
  const t2rows = [
    [s.kr.metric, "Key Result", s.kr.current, s.kr.target, s.kr.deadline, s.kr.cs],
  ].concat(
    s.outputs
      .filter((o) => o.name.trim())
      .map((o) => [o.name, "Critical Output", o.current, o.target, o.deadline, o.cs]),
  );
  L.push(mdTable(t2[0], t2rows));
  L.push("");
  L.push("## 3. SOLUTION DIRECTION + LEVER BEHAVIORS");
  L.push("");
  L.push(`**Solution Direction:** ${s.solution.direction.trim() || "(chưa điền)"}`);
  if (s.solution.logic.trim()) {
    L.push("");
    L.push(`**Logic chốt hướng (kiểm chứng bằng bằng chứng):** ${s.solution.logic.trim()}`);
  }
  L.push("");
  L.push(
    mdTable(
      ["Chủ thể", "Lever Behavior", "Bối cảnh", "Output tác động", "Dấu hiệu quan sát được", "Tần suất"],
      s.behaviors
        .filter((b) => b.behavior.trim())
        .map((b) => [b.actor, b.behavior, b.context, b.outputs, b.signal, b.freq]),
    ),
  );
  L.push("");
  L.push("## 4. CONDITIONS | 6 BOXES");
  L.push("");
  L.push(
    mdTable(
      ["6 Boxes", "Điều kiện cần", "Hiện trạng / Bằng chứng", "Khoảng cách", "Ưu tiên", "Hành vi liên quan", "Hành động sơ bộ", "Người sở hữu"],
      s.boxes.map((b) => [
        b.box, b.condition, b.evidence, b.gap, b.priority,
        behaviorName(s, b.behavior_id), b.action, b.assignee_label,
      ]),
    ),
  );
  L.push("");
  L.push("## 5. ACTION EXPERIMENT");
  L.push("");
  L.push(
    mdTable(
      ["Action", "Start", "Deadline", "Owner", "Supporter", "Success Criteria", "Status", "Risk / Adjustment"],
      s.actions
        .filter((a) => a.action.trim())
        .map((a) => [a.action, a.start, a.deadline, a.assignee_label, a.supporter_label, a.criteria, a.status, a.risk]),
    ),
  );
  if (s.risks.trim()) {
    L.push("");
    L.push("**Rủi ro / Giả định cần kiểm chứng:**");
    L.push("");
    s.risks
      .trim()
      .split(/\n+/)
      .forEach((line) =>
        L.push(
          line.trim().startsWith("-") || line.trim().startsWith("•")
            ? line.trim().replace(/^•/, "-")
            : "- " + line.trim(),
        ),
      );
  }
  L.push("");
  L.push("## 6. FOLLOW-UP EVIDENCE APPROPRIATE TO STAGE");
  L.push("");
  L.push("### Measurement Plan");
  L.push("");
  L.push(
    mdTable(
      ["planned_date", "evidence_layer", "metric_or_criterion", "baseline", "target", "data_source", "collector", "verifier"],
      s.plan
        .filter((p) =>
          Object.entries(p).some(([k, v]) => k !== "id" && str(v).trim()),
        )
        .map((p) => [p.date, p.layer, p.metric, p.baseline, p.target, p.source, p.collector, p.verifier]),
    ),
  );
  L.push("");
  L.push("### Observed Evidence");
  L.push("");
  L.push(
    mdTable(
      ["observed_date", "evidence_layer", "value_or_evidence", "source_reference", "confidence", "learning", "decision", "verifier"],
      observedRows(s),
    ),
  );
  L.push("");
  L.push("### Lịch Review & bài học");
  L.push("");
  L.push(
    mdTable(
      ["Mốc Review", "Ngày", "Behavior Evidence", "Output Evidence", "Result Evidence", "Điều hiệu quả", "Điều chưa hiệu quả", "Learning & Next Step", "Người xác nhận"],
      s.reviews
        .filter((r) =>
          Object.entries(r).some(([k, v]) => k !== "id" && str(v).trim()),
        )
        .map((r) => [
          r.checkpoint, r.date, r.behavior_evidence, r.output_evidence,
          r.result_evidence, r.works, r.not_works, r.learning, r.verifier,
        ]),
    ),
  );
  L.push("");
  return L.join("\n");
}

/* ================= Markdown import ================= */

function cleanCell(v) {
  let s = str(v).replace(/`/g, "").trim();
  s = s
    .replace(/^\*\*([\s\S]*)\*\*$/, "$1")
    .replace(/^\*([\s\S]*)\*$/, "$1")
    .trim();
  if (/^\((chưa điền|chưa đặt tên|chưa có dữ liệu)\)$/i.test(s) || /^TBD$/i.test(s))
    return "";
  return s;
}
function splitRow(line) {
  const SUB = "\u0000";
  let s = line.trim().replace(/\\\|/g, SUB);
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.split(SUB).join("|").trim());
}
function isSepRow(line) {
  const s = line.trim();
  return /^\|?[\s:|\-]+\|?$/.test(s) && s.indexOf("-") >= 0;
}
function mdTablesIn(lines) {
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const headers = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].trim().startsWith("|") && !isSepRow(lines[j]); j++)
        rows.push(splitRow(lines[j]));
      tables.push({ headers, rows });
      i = j - 1;
    }
  }
  return tables;
}
function fitRow(r, k, warnings, ctx) {
  if (r.length === k) return r;
  warnings.push(
    ctx + ": bảng có " + r.length + " cột thay vì " + k + " — đã tự căn lại, hãy kiểm tra.",
  );
  const out = r.slice(0, k);
  while (out.length < k) out.push("");
  return out;
}
function foldVn(t) {
  return str(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}
function normEnum(v, options, warnings, ctx) {
  const s = cleanCell(v);
  if (!s) return "";
  const lower = foldVn(s);
  for (const o of options) {
    if (lower === foldVn(o)) return o;
  }
  for (const o of options) {
    if (lower.startsWith(foldVn(o))) {
      if (ctx)
        warnings.push(
          ctx + ": “" + s + "” được rút gọn thành “" + o + "” (phần chú thích thêm bị lược).",
        );
      return o;
    }
  }
  if (ctx)
    warnings.push(
      ctx + ": giá trị “" + s + "” không khớp danh sách chuẩn (" + options.join(" / ") + ") — để trống, hãy chọn lại.",
    );
  return "";
}
function grabLabeled(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(re);
    if (!m) continue;
    let val = m[1].trim();
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (
        !t || t.startsWith("|") || t.startsWith("#") || t.startsWith("**") ||
        t.startsWith("*(") || t.startsWith("- ") || t.startsWith("• ")
      )
        break;
      val += " " + t;
    }
    return val;
  }
  return null;
}
function rowHasData(obj) {
  return Object.values(obj).some((v) => str(v).trim());
}

/**
 * Parse the export Markdown format back into a canonical body — ids are
 * generated fresh (the format carries none); behavior names resolve to
 * behavior_id inside sanitizeBody.
 */
export function parseCanvasMarkdown(md) {
  const warnings = [];
  md = str(md).replace(/\r\n?/g, "\n");
  const lines = md.split("\n");
  let title = null;
  const sec = {};
  const sub = {};
  let cur = null;
  let curSub = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+PERFORMANCE\s+ARCHITECTURE\s+CANVAS\s*[—–-]+\s*(.+?)\s*$/i);
    if (h1 && title === null) {
      title = h1[1];
      continue;
    }
    const h = line.match(/^##\s*([1-6])\s*[\.．]?\s/);
    if (h) {
      cur = h[1];
      curSub = null;
      sec[cur] = sec[cur] || [];
      continue;
    }
    const h3 = line.match(/^###\s*(.+)$/);
    if (h3 && cur === "6") {
      const t = h3[1].toLowerCase();
      curSub =
        t.indexOf("measurement") >= 0
          ? "plan"
          : t.indexOf("observed") >= 0
            ? "observed"
            : t.indexOf("review") >= 0 || t.indexOf("lịch") >= 0
              ? "reviews"
              : null;
      if (curSub) {
        sub[curSub] = sub[curSub] || [];
        continue;
      }
    }
    if (cur === "6" && curSub) sub[curSub].push(line);
    else if (cur) sec[cur].push(line);
  }
  if (title === null && !Object.keys(sec).length)
    throw new Error(
      "Không nhận diện được canvas trong nội dung dán vào. Hãy dán đúng bản canvas Markdown đầy đủ (bắt đầu bằng “# PERFORMANCE ARCHITECTURE CANVAS — …”), hoặc dán JSON đã tải từ nút “JSON (sao lưu)”.",
    );
  if (title === null)
    warnings.push(
      "Không tìm thấy dòng tiêu đề “# PERFORMANCE ARCHITECTURE CANVAS — …” — tên canvas để trống.",
    );
  ["1", "2", "3", "4", "5", "6"].forEach((n) => {
    if (!sec[n])
      warnings.push("Thiếu mục “## " + n + ".” — phần này để trống, hãy điền tay.");
  });
  const p = { meta: {}, goal: {}, kr: {}, solution: {} };
  const grabMeta = (label) => {
    const m = md.match(new RegExp("\\*\\*" + label + ":\\*\\*\\s*([^·\\n*]+)"));
    return m ? m[1].trim() : "";
  };
  p.meta.title = cleanCell(title || "");
  p.meta.stage = normEnum(grabMeta("Canvas Stage"), ENUMS.stages, warnings, "Canvas Stage") || "DRAFT";
  p.meta.mode = normEnum(grabMeta("Build Mode"), ENUMS.modes, warnings, "Build Mode") || "GUIDED";
  p.meta.updated = isoDate(grabMeta("Last Updated"));
  p.meta.owner = cleanCell(grabMeta("Người lập"));
  if (/migrated/i.test(grabMeta("Migration Status")))
    warnings.push("Canvas gốc có Migration Status “Migrated…” — trang này luôn lưu ở dạng Native v3.");
  // §1 GOAL
  {
    const L = sec["1"] || [];
    p.goal.context = cleanCell(grabLabeled(L, /^\*\*Bối cảnh[^:]*:\*\*\s*(.*)$/i) || "");
    const stmt = [];
    for (const l of L) {
      const t = l.trim();
      if (!t) {
        if (stmt.length) break;
        else continue;
      }
      if (t.startsWith("|") || t.startsWith("**") || t.startsWith("#")) break;
      stmt.push(t);
    }
    p.goal.statement = cleanCell(stmt.join("\n"));
  }
  // §2 KEY RESULT + OUTPUTS
  {
    const L = sec["2"] || [];
    const t = mdTablesIn(L).find((tb) => tb.headers.length >= 4);
    p.outputs = [];
    if (t) {
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 6, warnings, "Bước 2, dòng " + (idx + 1));
        if (/key result/i.test(cleanCell(r[1]))) {
          p.kr = {
            metric: cleanCell(r[0]), current: cleanCell(r[2]),
            target: cleanCell(r[3]), deadline: cleanCell(r[4]),
            cs: cleanCell(r[5]),
          };
        } else {
          p.outputs.push({
            name: cleanCell(r[0]), current: cleanCell(r[2]),
            target: cleanCell(r[3]), deadline: cleanCell(r[4]),
            cs: cleanCell(r[5]),
          });
        }
      });
    } else if (sec["2"])
      warnings.push("Bước 2: không tìm thấy bảng Key Result / Critical Outputs.");
    p.outputs = p.outputs.filter(rowHasData);
  }
  // §3 SOLUTION + BEHAVIORS
  {
    const L = sec["3"] || [];
    p.solution.direction = cleanCell(grabLabeled(L, /^\*\*Solution Direction:\*\*\s*(.*)$/i) || "");
    p.solution.logic = cleanCell(grabLabeled(L, /^\*\*Logic chốt hướng[^:]*:\*\*\s*(.*)$/i) || "");
    const t = mdTablesIn(L).find((tb) => tb.headers.length >= 5);
    p.behaviors = [];
    if (t)
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 6, warnings, "Bước 3, dòng " + (idx + 1));
        p.behaviors.push({
          actor: cleanCell(r[0]), behavior: cleanCell(r[1]),
          context: cleanCell(r[2]), outputs: cleanCell(r[3]),
          signal: cleanCell(r[4]), freq: cleanCell(r[5]),
        });
      });
    else if (sec["3"]) warnings.push("Bước 3: không tìm thấy bảng Lever Behaviors.");
    p.behaviors = p.behaviors.filter(rowHasData);
  }
  // §4 6 BOXES — behavior is a NAME here; sanitizeBody resolves it.
  {
    const L = sec["4"] || [];
    const t = mdTablesIn(L).find((tb) => tb.headers.length >= 6);
    p.boxes = [];
    if (t)
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 8, warnings, "Bước 4, dòng " + (idx + 1));
        const cellL = cleanCell(r[0]).toLowerCase();
        const bi = SIX_BOXES.findIndex((b) => {
          const [vn, en] = b.split(" | ").map((x) => x.toLowerCase());
          return cellL.indexOf(vn) >= 0 || cellL.indexOf(en) >= 0;
        });
        if (bi < 0) {
          warnings.push(
            "Bước 4, dòng " + (idx + 1) + ": không nhận diện được box “" + cleanCell(r[0]) + "” — bỏ qua dòng này.",
          );
          return;
        }
        p.boxes.push({
          box: SIX_BOXES[bi], condition: cleanCell(r[1]), evidence: cleanCell(r[2]),
          gap: normEnum(r[3], ENUMS.gap, warnings, "Bước 4 (Khoảng cách)"),
          priority: normEnum(r[4], ENUMS.priority, warnings, "Bước 4 (Ưu tiên)"),
          behavior: cleanCell(r[5]), action: cleanCell(r[6]),
          owner: cleanCell(r[7]),
        });
      });
    else if (sec["4"]) warnings.push("Bước 4: không tìm thấy bảng 6 Boxes.");
  }
  // §5 ACTION EXPERIMENT + risks
  {
    const L = sec["5"] || [];
    const t = mdTablesIn(L).find((tb) => tb.headers.length >= 6);
    p.actions = [];
    if (t)
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 8, warnings, "Bước 5, dòng " + (idx + 1));
        p.actions.push({
          action: cleanCell(r[0]), start: isoDate(r[1]), deadline: isoDate(r[2]),
          owner: cleanCell(r[3]), supporter: cleanCell(r[4]), criteria: cleanCell(r[5]),
          status: normEnum(r[6], ENUMS.status, warnings, "Bước 5 (Trạng thái)") || "Chưa bắt đầu",
          risk: cleanCell(r[7]),
        });
      });
    else if (sec["5"]) warnings.push("Bước 5: không tìm thấy bảng Action Experiment.");
    p.actions = p.actions.filter(rowHasData);
    const riskLines = [];
    let inRisk = false;
    for (const l of L) {
      const tl = l.trim();
      if (/^\*\*Rủi ro[^:]*:\*\*/i.test(tl)) {
        inRisk = true;
        continue;
      }
      if (!inRisk) continue;
      if (tl.startsWith("|") || tl.startsWith("**")) break;
      if (tl.startsWith("- ") || tl.startsWith("• "))
        riskLines.push(
          tl.replace(/^[-•]\s*/, "").replace(/\*\*/g, "").replace(/\*/g, "").trim(),
        );
    }
    p.risks = riskLines.join("\n");
  }
  // §6 EVIDENCE — 3 sub-tables
  {
    const grabTable = (name, k) => {
      const t = mdTablesIn(sub[name] || []).find(
        (tb) => tb.headers.length >= Math.min(k, 6),
      );
      return t ? t.rows.map((r, idx) => fitRow(r, k, warnings, "Bước 6 (" + name + "), dòng " + (idx + 1))) : [];
    };
    p.plan = grabTable("plan", 8)
      .map((r) => ({
        date: isoDate(r[0]),
        layer: normEnum(r[1], ENUMS.layer, warnings, "Measurement Plan (tầng)"),
        metric: cleanCell(r[2]), baseline: cleanCell(r[3]), target: cleanCell(r[4]),
        source: cleanCell(r[5]), collector: cleanCell(r[6]), verifier: cleanCell(r[7]),
      }))
      .filter(rowHasData);
    p.observed = grabTable("observed", 8)
      .map((r) => ({
        date: isoDate(r[0]),
        layer: normEnum(r[1], ENUMS.layer, warnings, "Observed Evidence (tầng)"),
        value: cleanCell(r[2]), source: cleanCell(r[3]),
        confidence: normEnum(r[4], ENUMS.confidence, warnings, "Observed Evidence (độ tin cậy)"),
        learning: cleanCell(r[5]),
        decision: normEnum(r[6], ENUMS.decision, warnings, "Observed Evidence (quyết định)"),
        verifier: cleanCell(r[7]),
      }))
      .filter(rowHasData);
    p.reviews = grabTable("reviews", 9)
      .map((r) => ({
        checkpoint: cleanCell(r[0]), date: isoDate(r[1]),
        behaviorEv: cleanCell(r[2]), outputEv: cleanCell(r[3]), resultEv: cleanCell(r[4]),
        works: cleanCell(r[5]), notWorks: cleanCell(r[6]),
        learning: cleanCell(r[7]), verifier: cleanCell(r[8]),
      }))
      .filter(rowHasData);
    if (sec["6"] && !sub.plan) warnings.push("Bước 6: thiếu bảng “Measurement Plan”.");
  }
  return { body: sanitizeBody(p, warnings), warnings };
}

/** Paste/import entry: JSON (canonical body, DTO, or legacy state) or Markdown. */
export function importCanvasText(text) {
  const t = str(text).trim();
  if (!t)
    throw new Error("Chưa có nội dung — hãy dán Markdown canvas hoặc JSON vào ô trên rồi bấm lại.");
  if (t[0] === "{") {
    let obj;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new Error("JSON không hợp lệ — hãy dán đúng nội dung file đã tải từ nút “JSON (sao lưu)”.");
    }
    const warnings = [];
    return { body: sanitizeBody(obj, warnings), warnings };
  }
  return parseCanvasMarkdown(t);
}

/* ================= Preview HTML (escaped — safe to innerHTML) ================= */

function pv(v) {
  return esc(str(v).trim()).replace(/\n/g, "<br>");
}
function pvTable(headers, rows) {
  if (!rows.length) return "<p><i>(chưa có dữ liệu)</i></p>";
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${pv(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/**
 * Render the printable preview for ANY body (draft or published
 * snapshot). Every dynamic value passes esc() — the returned markup is
 * safe for innerHTML and never executes user text.
 */
export function previewHtml(body, logoUrl) {
  const m = body.meta;
  const s = body;
  let h = `<div class="phead"><img src="${logoUrl}" alt=""><div><div class="pbrand">GoWise Partners</div><h1>PERFORMANCE ARCHITECTURE CANVAS — ${esc(m.title.trim() || "(chưa đặt tên)")}</h1></div></div>
  <div class="pmeta"><b>Canvas Stage:</b> ${esc(m.stage)} · <b>Build Mode:</b> ${esc(m.mode)} · <b>Schema Version:</b> ${esc(m.schema || CANVAS_BUSINESS_SCHEMA)} · <b>Last Updated:</b> ${esc(m.updated)} · <b>Migration Status:</b> Native v3${m.owner.trim() ? ` · <b>Người lập:</b> ${esc(m.owner)}` : ""}</div>`;
  h += `<h2>1. GOAL | MỤC TIÊU</h2><p>${pv(s.goal.statement) || "<i>(chưa điền)</i>"}</p>`;
  if (s.goal.context.trim()) h += `<p><b>Bối cảnh &amp; phạm vi:</b> ${pv(s.goal.context)}</p>`;
  h += `<h2>2. KEY RESULT + CRITICAL OUTPUTS / CS</h2>`;
  h += pvTable(
    ["Thành phần", "Loại", "Hiện tại", "Mục tiêu", "Thời hạn", "Tiêu chuẩn chất lượng (CS)"],
    [[s.kr.metric, "Key Result", s.kr.current, s.kr.target, s.kr.deadline, s.kr.cs]].concat(
      s.outputs
        .filter((o) => o.name.trim())
        .map((o) => [o.name, "Critical Output", o.current, o.target, o.deadline, o.cs]),
    ),
  );
  h += `<h2>3. SOLUTION DIRECTION + LEVER BEHAVIORS</h2>
      <p><b>Solution Direction:</b> ${pv(s.solution.direction) || "<i>(chưa điền)</i>"}</p>`;
  if (s.solution.logic.trim()) h += `<p><b>Logic chốt hướng:</b> ${pv(s.solution.logic)}</p>`;
  h += pvTable(
    ["Chủ thể", "Lever Behavior", "Bối cảnh", "Output tác động", "Dấu hiệu quan sát được", "Tần suất"],
    s.behaviors
      .filter((b) => b.behavior.trim())
      .map((b) => [b.actor, b.behavior, b.context, b.outputs, b.signal, b.freq]),
  );
  h += `<h2>4. CONDITIONS | 6 BOXES</h2>`;
  h += pvTable(
    ["6 Boxes", "Điều kiện cần", "Hiện trạng / Bằng chứng", "Khoảng cách", "Ưu tiên", "Hành vi liên quan", "Hành động sơ bộ", "Người sở hữu"],
    s.boxes.map((b) => [
      b.box.split(" | ")[0], b.condition, b.evidence, b.gap, b.priority,
      behaviorName(s, b.behavior_id), b.action, b.assignee_label,
    ]),
  );
  h += `<h2>5. ACTION EXPERIMENT</h2>`;
  h += pvTable(
    ["Action", "Start", "Deadline", "Owner", "Supporter", "Success Criteria", "Status", "Risk / Adjustment"],
    s.actions
      .filter((a) => a.action.trim())
      .map((a) => [a.action, a.start, a.deadline, a.assignee_label, a.supporter_label, a.criteria, a.status, a.risk]),
  );
  if (s.risks.trim()) h += `<p><b>Rủi ro / Giả định cần kiểm chứng:</b><br>${pv(s.risks)}</p>`;
  h += `<h2>6. FOLLOW-UP EVIDENCE APPROPRIATE TO STAGE</h2><h3>Measurement Plan</h3>`;
  h += pvTable(
    ["planned_date", "layer", "metric_or_criterion", "baseline", "target", "data_source", "collector", "verifier"],
    s.plan
      .filter((p) => Object.entries(p).some(([k, v]) => k !== "id" && str(v).trim()))
      .map((p) => [p.date, p.layer, p.metric, p.baseline, p.target, p.source, p.collector, p.verifier]),
  );
  h += `<h3>Observed Evidence${m.stage === "DRAFT" ? " (DRAFT — chưa có quan sát)" : ""}</h3>`;
  h += pvTable(
    ["observed_date", "layer", "value_or_evidence", "source_reference", "confidence", "learning", "decision", "verifier"],
    observedRows(s),
  );
  h += `<h3>Lịch Review &amp; bài học</h3>`;
  h += pvTable(
    ["Mốc Review", "Ngày", "Behavior Ev.", "Output Ev.", "Result Ev.", "Điều hiệu quả", "Điều chưa hiệu quả", "Learning & Next Step", "Người xác nhận"],
    s.reviews
      .filter((r) => Object.entries(r).some(([k, v]) => k !== "id" && str(v).trim()))
      .map((r) => [
        r.checkpoint, r.date, r.behavior_evidence, r.output_evidence,
        r.result_evidence, r.works, r.not_works, r.learning, r.verifier,
      ]),
  );
  h += `<div class="pfoot"><b>GoWise Partners</b> · GoWise Performance Theory — GOAL → RESULT → OUTPUT → BEHAVIOR → CONDITIONS → EVIDENCE · Xuất từ Canvas Online (schema ${esc(CANVAS_BUSINESS_SCHEMA)}) ngày ${esc(new Date().toLocaleDateString("vi-VN"))}</div>`;
  return h;
}

/* ================= XLSX export (zip STORE + inline strings) ================= */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (v) => [v & 255, (v >> 8) & 255];
const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = u16(0);
  const dosDate = u16(((2026 - 1980) << 9) | (8 << 5) | 5);
  files.forEach((f) => {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const head = [
      80, 75, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...dosTime, ...dosDate,
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(head), name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += head.length + name.length + data.length;
  });
  let cdSize = 0;
  const cdStart = offset;
  central.forEach((e) => {
    const rec = [
      80, 75, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...dosTime, ...dosDate,
      ...u32(e.crc), ...u32(e.size), ...u32(e.size), ...u16(e.name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(e.offset),
    ];
    chunks.push(new Uint8Array(rec), e.name);
    cdSize += rec.length + e.name.length;
  });
  chunks.push(
    new Uint8Array([
      80, 75, 5, 6, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
      ...u32(cdSize), ...u32(cdStart), ...u16(0),
    ]),
  );
  return new Blob(chunks, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
function xEsc(s) {
  return str(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
function colName(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - r - 1) / 26;
  }
  return s;
}
function sheetXML(rows) {
  let out = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>`;
  for (let c = 1; c <= 12; c++) out += `<col min="${c}" max="${c}" width="26" customWidth="1"/>`;
  out += `</cols><sheetData>`;
  rows.forEach((cells, ri) => {
    if (!cells) return;
    out += `<row r="${ri + 1}">`;
    cells.forEach((cell, ci) => {
      if (cell == null) return;
      const v = typeof cell === "object" ? cell.v : cell;
      const s = typeof cell === "object" ? cell.s || 1 : 1;
      if (String(v) === "") return;
      out += `<c r="${colName(ci + 1)}${ri + 1}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xEsc(v)}</t></is></c>`;
    });
    out += `</row>`;
  });
  out += `</sheetData></worksheet>`;
  return out;
}
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFE7D0A2"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0D1B2A"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const H = (v) => ({ v, s: 3 });
const B = (v) => ({ v, s: 2 });

function buildXlsxRows(body) {
  const m = body.meta;
  const s = body;
  const rows = [];
  const push = (...cells) => rows.push(cells.length ? cells : null);
  push(B("Canvas Stage"), m.stage);
  push(B("Build Mode"), m.mode);
  push(B("Schema Version"), m.schema || CANVAS_BUSINESS_SCHEMA);
  push(B("Last Updated"), m.updated);
  push(B("Migration Status"), "Native v3");
  push();
  push(B("PERFORMANCE ARCHITECTURE CANVAS — " + (m.title.trim() || "(chưa đặt tên)")));
  if (m.owner.trim()) push(B("Người lập"), m.owner);
  push();
  push(B("1. GOAL | MỤC TIÊU"));
  push(s.goal.statement);
  if (s.goal.context.trim()) push("Bối cảnh & phạm vi: " + s.goal.context);
  push();
  push(B("2. KEY RESULT + CRITICAL OUTPUTS / CS"));
  push(H("Thành phần"), H("Loại"), H("Hiện tại"), H("Mục tiêu"), H("Thời hạn"), H("Tiêu chuẩn chất lượng (CS)"));
  push(s.kr.metric, "Key Result", s.kr.current, s.kr.target, s.kr.deadline, s.kr.cs);
  s.outputs.filter((o) => o.name.trim()).forEach((o) => push(o.name, "Critical Output", o.current, o.target, o.deadline, o.cs));
  push();
  push(B("3. SOLUTION DIRECTION + LEVER BEHAVIORS"));
  push("Solution Direction: " + s.solution.direction);
  if (s.solution.logic.trim()) push("Logic chốt hướng: " + s.solution.logic);
  push(H("Chủ thể"), H("Lever Behavior"), H("Bối cảnh"), H("Output tác động"), H("Dấu hiệu quan sát được"), H("Tần suất"));
  s.behaviors.filter((b) => b.behavior.trim()).forEach((b) => push(b.actor, b.behavior, b.context, b.outputs, b.signal, b.freq));
  push();
  push(B("4. CONDITIONS | 6 BOXES"));
  push(H("6 Boxes"), H("Điều kiện cần"), H("Hiện trạng / Bằng chứng"), H("Khoảng cách"), H("Ưu tiên"), H("Hành vi liên quan"), H("Hành động sơ bộ"), H("Người sở hữu"));
  s.boxes.forEach((b) => push(b.box, b.condition, b.evidence, b.gap, b.priority, behaviorName(s, b.behavior_id), b.action, b.assignee_label));
  push();
  push(B("5. ACTION EXPERIMENT"));
  push(H("Action"), H("Start"), H("Deadline"), H("Owner"), H("Supporter"), H("Success Criteria"), H("Status"), H("Risk / Adjustment"));
  s.actions.filter((a) => a.action.trim()).forEach((a) => push(a.action, a.start, a.deadline, a.assignee_label, a.supporter_label, a.criteria, a.status, a.risk));
  if (s.risks.trim()) push("Rủi ro / Giả định cần kiểm chứng: " + s.risks);
  push();
  push(B("6. FOLLOW-UP EVIDENCE APPROPRIATE TO STAGE"));
  push(B("Measurement Plan"));
  push(H("planned_date"), H("evidence_layer"), H("metric_or_criterion"), H("baseline"), H("target"), H("data_source"), H("collector"), H("verifier"));
  s.plan.filter((p) => Object.entries(p).some(([k, v]) => k !== "id" && str(v).trim())).forEach((p) => push(p.date, p.layer, p.metric, p.baseline, p.target, p.source, p.collector, p.verifier));
  push();
  push(B("Observed Evidence"));
  push(H("observed_date"), H("evidence_layer"), H("value_or_evidence"), H("source_reference"), H("confidence"), H("learning"), H("decision"), H("verifier"));
  observedRows(s).forEach((r) => push(...r));
  push();
  push(B("Lịch Review & bài học"));
  push(H("Mốc Review"), H("Ngày"), H("Behavior Evidence"), H("Output Evidence"), H("Result Evidence"), H("Điều hiệu quả"), H("Điều chưa hiệu quả"), H("Learning & Next Step"), H("Người xác nhận"));
  s.reviews.filter((r) => Object.entries(r).some(([k, v]) => k !== "id" && str(v).trim())).forEach((r) => push(r.checkpoint, r.date, r.behavior_evidence, r.output_evidence, r.result_evidence, r.works, r.not_works, r.learning, r.verifier));
  return rows;
}

export function buildXlsx(body) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Canvas" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES_XML },
    { name: "xl/worksheets/sheet1.xml", data: sheetXML(buildXlsxRows(body)) },
  ];
  return zipStore(files);
}

/* ================= Download helpers ================= */

export function slug(body) {
  const t = (body.meta.title || "canvas")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "canvas";
  return "canvas-" + t + "-" + (body.meta.updated || "").replace(/-/g, "");
}

export function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}
