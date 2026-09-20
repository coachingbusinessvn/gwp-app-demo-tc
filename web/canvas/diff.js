/**
 * web/canvas/diff.js — conflict diff renderer (task 2.5).
 *
 * Renders a field-level diff between the LOCAL draft body (user's
 * unsaved edits — never silently replaced) and the SERVER draft body
 * (the newer revision another session wrote). All values render via
 * textContent — user text can never inject markup.
 *
 * Alignment: scalar sections diff by field; list sections (outputs,
 * behaviors, boxes, actions, plan, observed, reviews) align rows by
 * their stable row id, falling back to position for legacy rows that
 * predate ids.
 */

const STR = (v) => (v == null ? "" : String(v));

/** Human-readable labels for every editable path. */
const SCALAR_FIELDS = [
  ["meta.title", "Tên canvas", (b) => b.meta.title],
  ["meta.owner", "Người lập", (b) => b.meta.owner],
  ["meta.stage", "Stage", (b) => b.meta.stage],
  ["meta.mode", "Build Mode", (b) => b.meta.mode],
  ["goal.statement", "Mục tiêu (Goal)", (b) => b.goal.statement],
  ["goal.context", "Bối cảnh & phạm vi", (b) => b.goal.context],
  ["kr.metric", "Key Result — metric", (b) => b.kr.metric],
  ["kr.current", "Key Result — hiện tại", (b) => b.kr.current],
  ["kr.target", "Key Result — mục tiêu", (b) => b.kr.target],
  ["kr.deadline", "Key Result — thời hạn", (b) => b.kr.deadline],
  ["kr.cs", "Key Result — CS", (b) => b.kr.cs],
  ["solution.direction", "Solution Direction", (b) => b.solution.direction],
  ["solution.logic", "Logic chốt hướng", (b) => b.solution.logic],
  ["risks", "Rủi ro / Giả định", (b) => b.risks],
];

const ROW_FIELDS = {
  outputs: [
    ["name", "Tên"], ["current", "Hiện tại"], ["target", "Mục tiêu"],
    ["deadline", "Thời hạn"], ["cs", "CS"],
  ],
  behaviors: [
    ["actor", "Chủ thể"], ["behavior", "Hành vi"], ["context", "Bối cảnh"],
    ["outputs", "Output tác động"], ["signal", "Dấu hiệu"], ["freq", "Tần suất"],
  ],
  boxes: [
    ["condition", "Điều kiện"], ["evidence", "Hiện trạng"],
    ["gap", "Khoảng cách"], ["priority", "Ưu tiên"],
    ["behavior_id", "Hành vi liên quan"], ["action", "Hành động"],
    ["assignee_label", "Người sở hữu"],
  ],
  actions: [
    ["action", "Action"], ["start", "Start"], ["deadline", "Deadline"],
    ["assignee_label", "Owner"], ["supporter_label", "Supporter"],
    ["criteria", "Success Criteria"], ["status", "Status"], ["risk", "Risk"],
  ],
  plan: [
    ["date", "Ngày"], ["layer", "Tầng"], ["metric", "Metric"],
    ["baseline", "Baseline"], ["target", "Target"], ["source", "Nguồn"],
    ["collector", "Collector"], ["verifier", "Verifier"],
  ],
  observed: [
    ["date", "Ngày"], ["layer", "Tầng"], ["value", "Giá trị"],
    ["source", "Nguồn"], ["confidence", "Độ tin cậy"],
    ["learning", "Learning"], ["decision", "Quyết định"], ["verifier", "Verifier"],
  ],
  reviews: [
    ["checkpoint", "Mốc"], ["date", "Ngày"],
    ["behavior_evidence", "Behavior Ev."], ["output_evidence", "Output Ev."],
    ["result_evidence", "Result Ev."], ["works", "Hiệu quả"],
    ["not_works", "Chưa hiệu quả"], ["learning", "Learning"],
    ["verifier", "Người xác nhận"],
  ],
};

const ROW_TITLES = {
  outputs: "Critical Outputs",
  behaviors: "Lever Behaviors",
  boxes: "6 Boxes",
  actions: "Action Experiment",
  plan: "Measurement Plan",
  observed: "Observed Evidence",
  reviews: "Lịch Review",
};

function rowLabel(section, row, idx, resolveBehavior) {
  const pick = (r, keys) => {
    for (const k of keys) {
      const v = STR(r && r[k]).trim();
      if (v) return v;
    }
    return "";
  };
  switch (section) {
    case "outputs": return pick(row, ["name"]) || `dòng ${idx + 1}`;
    case "behaviors": return pick(row, ["behavior", "actor"]) || `dòng ${idx + 1}`;
    case "boxes": return pick(row, ["box"]) || `dòng ${idx + 1}`;
    case "actions": return pick(row, ["action"]) || `dòng ${idx + 1}`;
    case "reviews": return pick(row, ["checkpoint"]) || `dòng ${idx + 1}`;
    default: return `dòng ${idx + 1}`;
  }
}

/** Align two row lists by id; rows without ids pair by position. */
function alignRows(localRows, serverRows) {
  const pairs = [];
  const used = new Set();
  const byId = new Map();
  serverRows.forEach((r, i) => {
    if (r && r.id) byId.set(r.id, i);
  });
  localRows.forEach((l, i) => {
    if (l && l.id && byId.has(l.id)) {
      const j = byId.get(l.id);
      used.add(j);
      pairs.push([l, serverRows[j], i]);
    }
  });
  // Remaining server rows (added remotely, or id-less) pair with
  // remaining local rows by order; extras diff against a blank.
  const freeLocal = localRows.filter((l, i) => !pairs.some((p) => p[2] === i));
  const freeServer = serverRows.filter((_, j) => !used.has(j));
  const n = Math.max(freeLocal.length, freeServer.length);
  for (let i = 0; i < n; i++) {
    pairs.push([freeLocal[i] || {}, freeServer[i] || {}, null]);
  }
  return pairs;
}

function rowValue(section, row, field, local, server, resolveBehavior) {
  const v = STR(row && row[field]);
  if (field === "behavior_id") return resolveBehavior(v) || (v ? "(id lạ)" : "");
  return v;
}

/**
 * Diff two canonical bodies → [{label, local, server}] entries where
 * values differ. `resolveBehavior(id)` maps a behavior_id to its name
 * for readable diffs.
 */
export function diffBodies(localBody, serverBody, resolveBehavior = () => "") {
  const changes = [];
  const add = (label, local, server) => {
    changes.push({ label, local: STR(local), server: STR(server) });
  };
  for (const [, label, get] of SCALAR_FIELDS) {
    const l = get(localBody);
    const s = get(serverBody);
    if (STR(l) !== STR(s)) add(label, l, s);
  }
  for (const [section, fields] of Object.entries(ROW_FIELDS)) {
    const localRows = Array.isArray(localBody[section]) ? localBody[section] : [];
    const serverRows = Array.isArray(serverBody[section]) ? serverBody[section] : [];
    const pairs = alignRows(localRows, serverRows);
    pairs.forEach(([l, s, origIdx], pi) => {
      const idx = origIdx == null ? pi : origIdx;
      const title = `${ROW_TITLES[section]} — ${rowLabel(section, l.id ? l : s, idx)}`;
      for (const [field, flabel] of fields) {
        const lv = rowValue(section, l, field, l, s, resolveBehavior);
        const sv = rowValue(section, s, field, l, s, resolveBehavior);
        if (lv !== sv) add(`${title} · ${flabel}`, lv, sv);
      }
    });
  }
  return changes;
}

/**
 * Render the diff into `container` (id="conflict-diff"). Everything is
 * built with createElement/textContent — safe for arbitrary user text.
 */
export function renderDiff(container, changes) {
  container.replaceChildren();
  if (!changes.length) {
    const p = document.createElement("p");
    p.className = "diff-empty";
    p.textContent =
      "Không thấy khác biệt ở nội dung — bản trên máy chủ chỉ khác phiên bản (revision). Nội dung của bạn vẫn được giữ nguyên.";
    container.appendChild(p);
    return;
  }
  const table = document.createElement("table");
  table.className = "diff-table";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of ["Trường", "Bản của bạn (chưa lưu)", "Bản trên máy chủ"]) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  const tbody = document.createElement("tbody");
  for (const c of changes) {
    const tr = document.createElement("tr");
    for (const v of [c.label, c.local, c.server]) {
      const td = document.createElement("td");
      td.textContent = v || "—";
      if (v === c.local) td.className = "diff-local";
      if (v === c.server) td.className = "diff-server";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  container.appendChild(table);
}
