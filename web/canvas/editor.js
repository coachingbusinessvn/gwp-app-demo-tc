/**
 * web/canvas/editor.js — the canvas editor page controller (task 2.5).
 *
 * Replaces the legacy localStorage editor with the real revision-aware
 * API: requireAuth gate → GET /canvases/:id (shared draft) → debounced
 * serialized CAS autosave (PUT /draft, expectedRevision + baseVersionId)
 * → publish → immutable-version history. There is NO runtime
 * localStorage persistence — a legacy "pac-canvas-online-v3" copy is
 * only offered as an explicitly confirmed import, never auto-loaded.
 *
 * Rendering safety: every dynamic value passes esc() before entering
 * innerHTML (the legacy pattern) or textContent; user text can never
 * execute as markup — verified by the e2e XSS test.
 */
import { apiFetch, apiFetchAll } from "../api.js";
import { requireAuth } from "../auth.js";
import {
  ENUMS,
  GUIDE,
  LIMITS,
  SIX_BOXES,
  STAGE_NOTES,
  STEPS,
  blankAction,
  blankBehavior,
  blankBody,
  blankObserved,
  blankOutput,
  blankPlanRow,
  blankReview,
  behaviorName,
  buildXlsx,
  download,
  esc,
  importCanvasText,
  previewHtml,
  sanitizeBody,
  slug,
} from "./model.js";
import { createAutosave } from "./autosave.js";
import { mountAiPanel } from "../ai/panel.js";
import { diffBodies, renderDiff } from "./diff.js";
import { exportDraftPreview } from "./export.js";
import { createHistoryPanel } from "./history.js";
import { mountCanvasManage } from "./manage.js";
import { GWP_LOGO } from "./logo.js";

const LEGACY_STORE_KEY = "pac-canvas-online-v3";
const $ = (id) => document.getElementById(id);

/* ================= Page state ================= */

let canvasId = null;
let state = null; // canonical body — the single form model
let revision = null; // draft.revision — advances ONLY from 200 responses
let baseVersionId = null; // draft.baseVersionId
let saveState = "idle"; // idle|dirty|saving|saved|error|conflict
let serverSnapshot = undefined; // server draft stashed at conflict time
let companyUsers = []; // [{id,name}] for assignee datalist resolution
let historyPanel = null;
let readOnly = false; // archived canvas — every write path is closed

const STATE_LABEL = {
  idle: "Bản nháp — chỉnh sửa sẽ tự lưu",
  dirty: "Chưa lưu…",
  saving: "Đang lưu…",
  saved: "Đã lưu",
  error: "Lỗi lưu — bấm Thử lại",
  conflict: "Xung đột — bản mới hơn trên máy chủ",
};

function setSaveState(next) {
  saveState = next;
  const el = $("saveState");
  if (el) {
    el.textContent = STATE_LABEL[next] || next;
    el.dataset.state = next;
  }
  const retry = $("saveRetry");
  if (retry) retry.hidden = next !== "error";
}

const isDirtyish = () =>
  saveState === "dirty" ||
  saveState === "saving" ||
  saveState === "error" ||
  saveState === "conflict";

/* ================= Autosave ================= */

/**
 * Snapshot of the last body we PUT — used to tell a REAL 409 (someone
 * else's write) from a self-conflict (our own write that landed but whose
 * response never came back — an aborted request can still commit
 * server-side, e.g. a keepalive flush during beforeunload). Key order is
 * not significant, so the comparison is a deep equal, not stringify.
 */
let lastSentBody = null;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b)
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && deepEqual(a[k], b[k]));
}

function serializeDraft(rev = revision) {
  lastSentBody = JSON.parse(JSON.stringify(state));
  return JSON.stringify({
    expectedRevision: rev,
    baseVersionId,
    body: state,
  });
}

async function putDraft(payload, keepalive = false) {
  return apiFetch(`/canvases/${canvasId}/draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: payload,
    // keepalive only for the unload path — browsers cap keepalive bodies
    // at ~64KiB, so ordinary saves must NOT set it (a large valid canvas
    // would fail with TypeError before a byte reaches the server).
    ...(keepalive ? { keepalive: true } : {}),
  });
}

async function applySavedDto(d) {
  revision = d.revision;
  baseVersionId = d.baseVersionId;
  return { status: 200 };
}

/** 409 → real conflict only when the server draft is NOT our own write. */
async function resolveConflict() {
  const serverDraft = await fetchServerDraft().catch(() => undefined);
  if (
    serverDraft &&
    lastSentBody &&
    deepEqual(serverDraft.body, lastSentBody)
  ) {
    // Our write committed but the acknowledgement was lost — adopt the
    // server revision and treat it as a save, not a conflict.
    adoptDraftPointers(serverDraft);
    return { status: 200 };
  }
  serverSnapshot = serverDraft;
  onConflict();
  return { status: 409 };
}

/**
 * The autosave send callback: PUT with CAS, advancing revision/base ONLY
 * from a 200 DraftDto. 404 means the draft row is gone (a publish
 * consumes it) — reopen it once, adopt the fresh pointers and retry;
 * never repopulate the form from it (the user's text is authoritative).
 */
async function sendSave(_body, opts) {
  const ka = !!(opts && opts.keepalive);
  const res = await putDraft(serializeDraft(), ka);
  if (res.status === 200) return applySavedDto(await res.json());
  if (res.status === 409) return resolveConflict();
  if (res.status === 404) {
    if (await reopenDraft()) {
      const again = await putDraft(serializeDraft(), ka);
      if (again.status === 200) return applySavedDto(await again.json());
      if (again.status === 409) return resolveConflict();
      return { status: again.status };
    }
    return { status: 404 };
  }
  return { status: res.status };
}

const autosave = createAutosave({
  debounceMs: 800,
  send: sendSave,
  setState: setSaveState,
});

function markDirty() {
  if (readOnly) return; // archived: the server would 409 every save
  autosave.schedule(() => state);
}

/* ================= Draft lifecycle ================= */

/** Adopt a fresh draft's CAS pointers — form content untouched. */
function adoptDraftPointers(d) {
  revision = d.revision;
  baseVersionId = d.baseVersionId;
}

/**
 * Re-open the shared draft after it was consumed (publish deletes the
 * draft row). POST /draft copies the head version; a 409 DRAFT_EXISTS
 * means a draft already exists — re-read the detail and adopt it.
 */
async function reopenDraft() {
  const res = await apiFetch(`/canvases/${canvasId}/draft`, {
    method: "POST",
  });
  if (res.status === 201) {
    adoptDraftPointers(await res.json());
    return true;
  }
  if (res.status === 409) {
    const det = await apiFetch(`/canvases/${canvasId}`);
    if (det.ok) {
      const detail = await det.json();
      if (detail.draft) {
        adoptDraftPointers(detail.draft);
        return true;
      }
    }
  }
  return false;
}

/* ================= Conflict UX ================= */

async function fetchServerDraft() {
  const res = await apiFetch(`/canvases/${canvasId}`);
  if (!res.ok) return undefined;
  const detail = await res.json();
  return detail.draft ?? null;
}

/** 409 DRAFT_CONFLICT: freeze autosave + banner; serverSnapshot stashed. */
function onConflict() {
  autosave.freeze();
  $("conflictBanner").hidden = false;
}

function bindConflictUI() {
  $("btnDiff").addEventListener("click", async () => {
    const box = $("conflictDiff");
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    if (serverSnapshot === undefined) {
      serverSnapshot = await fetchServerDraft();
    }
    if (serverSnapshot === null) {
      // Draft is gone server-side (published elsewhere) — the head
      // version is the "server side" for the diff.
      const det = await apiFetch(`/canvases/${canvasId}`);
      const detail = det.ok ? await det.json() : null;
      const headId = detail?.currentVersion?.id;
      let headBody = null;
      if (headId) {
        const v = await apiFetch(
          `/canvases/${canvasId}/versions/${headId}`,
        );
        if (v.ok) headBody = (await v.json()).body;
      }
      renderDiff(
        box,
        headBody
          ? diffBodies(state, headBody, resolveBehaviorName)
          : [],
      );
      if (!headBody) {
        box.replaceChildren();
        const p = document.createElement("p");
        p.textContent =
          "Bản nháp trên máy chủ đã bị chốt/xoá — không còn bản để so. Bấm “Tải bản mới nhất” để lấy nội dung mới nhất.";
        box.appendChild(p);
      }
    } else {
      renderDiff(
        box,
        diffBodies(state, serverSnapshot.body, resolveBehaviorName),
      );
    }
    box.hidden = false;
  });

  $("btnCopyLocal").addEventListener("click", async () => {
    const text = JSON.stringify(state, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      $("btnCopyLocal").textContent = "✓ Đã sao chép";
    } catch {
      // Clipboard may be denied — fall back to a selectable textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.readOnly = true;
      ta.style.minHeight = "120px";
      const box = $("conflictDiff");
      box.replaceChildren(ta);
      box.hidden = false;
    }
  });

  $("btnReloadLatest").addEventListener("click", async () => {
    const ok = window.confirm(
      "Tải bản mới nhất từ máy chủ? Nội dung bạn đang gõ trên trang này sẽ được thay thế (hãy “Sao chép bản của tôi” trước nếu cần giữ).",
    );
    if (!ok) return;
    let draft = await fetchServerDraft();
    if (draft === null) {
      // Consumed elsewhere — reopening yields the head version's body.
      if (await reopenDraft()) draft = await fetchServerDraft();
    }
    if (!draft) {
      setSaveState("error");
      return;
    }
    adoptDraftPointers(draft);
    state = sanitizeBody(draft.body, [], true);
    populateForm();
    serverSnapshot = undefined;
    autosave.thaw();
    $("conflictBanner").hidden = true;
    $("conflictDiff").hidden = true;
    setSaveState("saved");
  });
}

function resolveBehaviorName(id) {
  return behaviorName(state, id);
}

/* ================= Publish ================= */

function setVersionChip(v) {
  const el = $("versionChip");
  if (!el) return;
  el.textContent = v ? `v${v.versionNo}` : "Nháp";
}

async function publish() {
  if (saveState === "conflict") {
    window.alert("Đang có xung đột chưa xử lý — xem banner phía trên.");
    return;
  }
  if (
    !window.confirm(
      "Chốt phiên bản hiện tại? Phiên bản đã chốt là bất biến — có thể xem lại, khôi phục hoặc tải về trong “Lịch sử”.",
    )
  )
    return;
  const note = window.prompt("Ghi chú phiên bản (tùy chọn):", "");
  // Publish must snapshot the server truth — settle pending autosave
  // first so expectedRevision is the latest committed one.
  if (isDirtyish()) {
    await autosave.flush(() => state);
  }
  if (saveState === "conflict") {
    window.alert("Đang có xung đột chưa xử lý — xem banner phía trên.");
    return;
  }
  if (saveState === "error") {
    window.alert("Bản nháp chưa lưu được — bấm “Thử lại” trước khi chốt.");
    return;
  }
  const res = await apiFetch(`/canvases/${canvasId}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      changeSummary: note && note.trim() ? note.trim() : undefined,
    }),
  });
  if (res.ok) {
    const { versionNo } = await res.json();
    setVersionChip({ versionNo });
    historyPanel?.invalidate();
    // Publish consumes the draft — reopen it so editing continues.
    await reopenDraft();
    setSaveState("saved");
    return;
  }
  if (res.status === 409) {
    onConflict();
    return;
  }
  if (res.status === 400) {
    const err = await res.json().catch(() => null);
    const fields = Array.isArray(err?.details?.fields)
      ? err.details.fields.join(", ")
      : "";
    window.alert(
      "Canvas chưa đủ điều kiện chốt phiên bản." +
        (fields ? `\nCần kiểm tra: ${fields}` : ""),
    );
    return;
  }
  window.alert("Không chốt được phiên bản — thử lại sau.");
}

/* ================= Form rendering (canonical keys) ================= */

function hintBlock(i) {
  const g = GUIDE[i];
  return `<details class="hints"><summary>Câu hỏi gợi ý &amp; tiêu chuẩn của bước này</summary>
  <div class="hint-body">
    <h4>Mục tiêu của bước</h4><p>${esc(g.muctieu)}</p>
    <h4>Câu hỏi cốt lõi</h4><p>${esc(g.cauhoi)}</p>
    <h4>Kết quả cần đạt</h4><p>${esc(g.ketqua)}</p>
    <h4>Lỗi thường gặp</h4><p class="hint-mistake">⚠ ${esc(g.loi)}</p>
    <h4>Tiêu chuẩn chất lượng</h4><p>${esc(g.chuan)}</p>
  </div></details>`;
}
function stepShell(i, innerHTML) {
  const s = STEPS[i];
  return `<section class="card" id="step${i + 1}">
    <h2 class="step-title">${i + 1}. ${esc(s.vn)}</h2>
    <div class="step-en">${esc(s.en)}</div>
    <p class="step-q">${esc(s.q)}</p>
    ${hintBlock(i)}
    ${innerHTML}
  </section>`;
}
function selectHTML(cls, options, value, allowBlank, attrs) {
  const opts = (allowBlank ? [""].concat(options) : options)
    .map(
      (o) =>
        `<option value="${esc(o)}"${o === value ? " selected" : ""}>${o === "" ? "—" : esc(o)}</option>`,
    )
    .join("");
  return `<select class="${cls}"${attrs || ""}>${opts}</select>`;
}

function renderSteps() {
  $("steps").innerHTML =
    stepShell(
      0,
      `
      <label for="f_goal">Mục tiêu (Goal)</label>
      <textarea id="f_goal" placeholder="Kết quả cuối cùng có ý nghĩa, phạm vi rõ — không phải danh sách hoạt động. Ví dụ: Nâng cao hiệu quả Marketing bằng cách tăng số lượng và chất lượng Qualified Leads."></textarea>
      <label for="f_goalctx">Bối cảnh &amp; phạm vi</label>
      <textarea id="f_goalctx" placeholder="Ai / đội nào, trong khoảng thời gian nào, vì sao mục tiêu này quan trọng với kinh doanh."></textarea>
    `,
    ) +
    stepShell(
      1,
      `
      <label style="margin-top:0">Key Result</label>
      <div class="grid4">
        <div><label class="sub" for="f_krmetric">Chỉ số đo</label><input type="text" id="f_krmetric" placeholder="Ví dụ: Qualified Leads / tháng"></div>
        <div><label class="sub" for="f_krcur">Hiện tại (baseline)</label><input type="text" id="f_krcur" placeholder="200"></div>
        <div><label class="sub" for="f_krtar">Mục tiêu (target)</label><input type="text" id="f_krtar" placeholder="260"></div>
        <div><label class="sub" for="f_krdl">Thời hạn</label><input type="text" id="f_krdl" placeholder="2026-06-30"></div>
      </div>
      <label for="f_krcs">Tiêu chuẩn chất lượng / cách đo Key Result</label>
      <input type="text" id="f_krcs" placeholder="Ví dụ: Số lead đạt tiêu chí qualified, đếm trên dashboard chung theo tháng">
      <label>Critical Outputs / CS <span class="opt">(1–3 đầu ra công việc quan sát được — không phải Activity — mỗi đầu ra có tiêu chuẩn chất lượng)</span></label>
      <div class="tbl-scroll"><table class="tbl" id="tblOutputs">
        <thead><tr><th style="width:24%">Critical Output</th><th style="width:12%">Hiện tại</th><th style="width:12%">Mục tiêu</th><th style="width:14%">Thời hạn</th><th>Tiêu chuẩn chất lượng (CS)</th><th style="width:30px"></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <button class="add" id="addOutput" type="button">+ Thêm Output (tối đa 3)</button>
    `,
    ) +
    stepShell(
      2,
      `
      <label style="margin-top:0" for="f_soldir">Solution Direction <span class="opt">(công thức: Động từ định hướng + Điểm tập trung + Key Result cần đạt)</span></label>
      <textarea id="f_soldir" placeholder="Ví dụ: Nâng cao chất lượng ra quyết định Marketing dựa trên dữ liệu nhằm tăng Qualified Leads từ 200 lên 260 mỗi tháng."></textarea>
      <p class="note">Mô tả năng lực cần khơi thông, không khóa sẵn một công cụ cụ thể (training, CRM, checklist, workshop…).</p>
      <label for="f_sollogic">Logic chốt hướng (kiểm chứng bằng bằng chứng)</label>
      <textarea id="f_sollogic" placeholder="Bằng chứng hiện trạng nào cho thấy hướng này hợp lý? Vì sao nó tác động đồng thời tới các Output?"></textarea>
      <label>Lever Behaviors <span class="opt">(2–5 hành vi; ưu tiên hành vi kéo các hành vi khác cùng xuất hiện)</span></label>
      <div class="tbl-scroll"><table class="tbl" id="tblBehaviors">
        <thead><tr><th style="width:15%">Chủ thể</th><th style="width:20%">Lever Behavior</th><th style="width:13%">Bối cảnh</th><th style="width:15%">Output tác động</th><th>Dấu hiệu quan sát được</th><th style="width:11%">Tần suất</th><th style="width:30px"></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <button class="add" id="addBehavior" type="button">+ Thêm hành vi (tối đa 5)</button>
    `,
    ) +
    stepShell(
      3,
      `
      <p class="note" style="margin-bottom:6px">Chẩn đoán <b>môi trường trước, cá nhân sau</b>. Mỗi dòng gắn với MỘT Lever Behavior đã khai ở bước 3.</p>
      <div class="tbl-scroll"><table class="tbl" id="tblBoxes">
        <thead><tr><th style="width:15%">6 Boxes</th><th style="width:15%">Điều kiện cần</th><th style="width:16%">Hiện trạng / Bằng chứng</th><th style="width:9%">Khoảng cách</th><th style="width:9%">Ưu tiên</th><th style="width:13%">Hành vi liên quan</th><th style="width:13%">Hành động sơ bộ</th><th>Người sở hữu</th></tr></thead>
        <tbody></tbody>
      </table></div>
    `,
    ) +
    stepShell(
      4,
      `
      <p class="note" style="margin-bottom:6px">Phạm vi 7–14 ngày; thử nghiệm nhỏ nhất có thể kiểm chứng. Ở stage DRAFT đây là thử nghiệm <b>đề xuất</b>, chưa phải đã hoàn thành.</p>
      <div class="tbl-scroll"><table class="tbl" id="tblActions">
        <thead><tr><th style="width:18%">Hành động</th><th style="width:10%">Bắt đầu</th><th style="width:10%">Kết thúc</th><th style="width:10%">Owner</th><th style="width:10%">Supporter</th><th style="width:16%">Success Criteria</th><th style="width:12%">Trạng thái</th><th>Rủi ro / Điều chỉnh</th><th style="width:30px"></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <button class="add" id="addAction" type="button">+ Thêm hành động</button>
      <label for="f_risks">Rủi ro / Giả định cần kiểm chứng</label>
      <textarea id="f_risks" placeholder="• Điều gì có thể khiến thử nghiệm không xảy ra?&#10;• Cần xử lý ngay điều gì?"></textarea>
    `,
    ) +
    stepShell(
      5,
      `
      <label style="margin-top:0">Measurement Plan <span class="opt">(kế hoạch đo — nên phủ đủ 3 tầng BEHAVIOR / OUTPUT / RESULT; tách người thu thập và người xác nhận)</span></label>
      <div class="tbl-scroll"><table class="tbl" id="tblPlan">
        <thead><tr><th style="width:11%">Ngày dự kiến</th><th style="width:10%">Tầng</th><th style="width:20%">Chỉ số / tiêu chí</th><th style="width:10%">Baseline</th><th style="width:10%">Target</th><th style="width:14%">Nguồn dữ liệu</th><th style="width:11%">Người thu thập</th><th>Người xác nhận</th><th style="width:30px"></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <button class="add" id="addPlan" type="button">+ Thêm dòng kế hoạch đo</button>

      <label>Observed Evidence <span class="opt">(quan sát thực tế — chỉ ghi những gì đã xảy ra)</span></label>
      <div id="observedZone">
      <div class="tbl-scroll"><table class="tbl" id="tblObserved">
        <thead><tr><th style="width:11%">Ngày quan sát</th><th style="width:10%">Tầng</th><th style="width:20%">Giá trị / bằng chứng</th><th style="width:13%">Nguồn trích dẫn</th><th style="width:9%">Độ tin cậy</th><th style="width:16%">Bài học</th><th style="width:10%">Quyết định</th><th>Người xác nhận</th><th style="width:30px"></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <button class="add" id="addObserved" type="button">+ Thêm quan sát</button>
      </div>
      <div class="stage-note" id="observedNote" style="display:none"></div>

      <label>Lịch Review &amp; bài học</label>
      <div class="tbl-scroll"><table class="tbl" id="tblReviews">
        <thead><tr><th style="width:11%">Mốc Review</th><th style="width:10%">Ngày</th><th style="width:12%">Behavior Evidence</th><th style="width:12%">Output Evidence</th><th style="width:12%">Result Evidence</th><th style="width:11%">Điều hiệu quả</th><th style="width:11%">Điều chưa hiệu quả</th><th style="width:12%">Learning &amp; Next Step</th><th>Người xác nhận</th><th style="width:30px"></th></tr></thead>
        <tbody></tbody>
      </table></div>
      <button class="add" id="addReview" type="button">+ Thêm mốc review</button>
    `,
    );
  bindStaticFields();
  renderAllRows();
}

/* ----- row cells: innerHTML template + esc() on every value ----- */

const txtCell = (list, i, key, ph) =>
  `<td><textarea data-l="${list}" data-i="${i}" data-k="${key}" placeholder="${esc(ph || "")}">${esc(state[list][i][key])}</textarea></td>`;
const inCell = (list, i, key, ph, type) =>
  `<td><input type="${type || "text"}" data-l="${list}" data-i="${i}" data-k="${key}" placeholder="${esc(ph || "")}" value="${esc(state[list][i][key])}"></td>`;
const selCell = (list, i, key, options, allowBlank) => {
  const v = state[list][i][key];
  const opts = (allowBlank ? [""].concat(options) : options)
    .map(
      (o) =>
        `<option value="${esc(o)}"${o === v ? " selected" : ""}>${o === "" ? "—" : esc(o)}</option>`,
    )
    .join("");
  return `<td><select data-l="${list}" data-i="${i}" data-k="${key}">${opts}</select></td>`;
};
const assigneeCell = (list, i) =>
  `<td><input type="text" data-l="${list}" data-i="${i}" data-k="assignee_label" list="userList" placeholder="Tên người sở hữu" value="${esc(state[list][i].assignee_label)}"></td>`;
const delCell = (list, i, min) =>
  `<td>${state[list].length <= (min || 1) ? "" : `<button class="rowbtn" type="button" data-del="${list}" data-i="${i}" title="Xóa dòng">✕</button>`}</td>`;

/** Options for the boxes.behavior_id select: {value:id, label:name}. */
function behaviorSelectCell(i) {
  const cur = state.boxes[i].behavior_id;
  const opts = state.behaviors
    .filter((b) => b.behavior.trim())
    .map(
      (b) =>
        `<option value="${esc(b.id)}"${b.id === cur ? " selected" : ""}>${esc(b.behavior)}</option>`,
    )
    .join("");
  return `<td><select data-l="boxes" data-i="${i}" data-k="behavior_id"><option value="">— Cần xác nhận —</option>${opts}</select></td>`;
}

function renderAllRows() {
  for (const l of [
    "outputs",
    "behaviors",
    "boxes",
    "actions",
    "plan",
    "observed",
    "reviews",
  ])
    renderRows(l);
  updateStageUI();
}

function renderRows(list) {
  const tableId = {
    outputs: "tblOutputs",
    behaviors: "tblBehaviors",
    boxes: "tblBoxes",
    actions: "tblActions",
    plan: "tblPlan",
    observed: "tblObserved",
    reviews: "tblReviews",
  }[list];
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!tbody) return;
  let html = "";
  state[list].forEach((row, i) => {
    if (list === "outputs") {
      html += `<tr>${txtCell(list, i, "name", "Ví dụ: Landing Page Conversion")}${inCell(list, i, "current", "8%")}${inCell(list, i, "target", "12%")}${inCell(list, i, "deadline", "2026-06-30")}${txtCell(list, i, "cs", "Đo bằng gì, đạt chuẩn nào thì tính là đạt")}${delCell(list, i, LIMITS.outputs[0])}</tr>`;
    } else if (list === "behaviors") {
      html += `<tr>${txtCell(list, i, "actor", "Ai")}${txtCell(list, i, "behavior", "Hành vi cụ thể, quan sát được")}${txtCell(list, i, "context", "Khi nào / ở đâu")}${txtCell(list, i, "outputs", "Tác động Output nào")}${txtCell(list, i, "signal", "Nhìn thấy gì khi làm tốt")}${txtCell(list, i, "freq", "Hàng tuần…")}${delCell(list, i, LIMITS.behaviors[0])}</tr>`;
    } else if (list === "boxes") {
      const [vn, en] = row.box.split(" | ");
      html += `<tr><td style="background:var(--brand-soft)"><b>${esc(vn)}</b><br><span style="font-size:11px;color:var(--muted)">${esc(en)}</span></td>${txtCell(list, i, "condition", "Cần có gì để hành vi xảy ra")}${txtCell(list, i, "evidence", "Hiện trạng + bằng chứng cụ thể")}${selCell(list, i, "gap", ENUMS.gap, true)}${selCell(list, i, "priority", ENUMS.priority, true)}${behaviorSelectCell(i)}${txtCell(list, i, "action", "Hành động sơ bộ")}${assigneeCell(list, i)}</tr>`;
    } else if (list === "actions") {
      html += `<tr>${txtCell(list, i, "action", "Thử nghiệm nhỏ, kiểm chứng được")}${inCell(list, i, "start", "", "date")}${inCell(list, i, "deadline", "", "date")}${assigneeCell(list, i)}${txtCell(list, i, "supporter_label", "")}${txtCell(list, i, "criteria", "Đạt gì thì tính là thành công")}${selCell(list, i, "status", ENUMS.status, false)}${txtCell(list, i, "risk", "Rủi ro & cách điều chỉnh")}${delCell(list, i, 1)}</tr>`;
    } else if (list === "plan") {
      html += `<tr>${inCell(list, i, "date", "", "date")}${selCell(list, i, "layer", ENUMS.layer, true)}${txtCell(list, i, "metric", "Đo cái gì")}${txtCell(list, i, "baseline", "")}${txtCell(list, i, "target", "")}${txtCell(list, i, "source", "Nguồn dữ liệu")}${txtCell(list, i, "collector", "")}${txtCell(list, i, "verifier", "")}${delCell(list, i, 1)}</tr>`;
    } else if (list === "observed") {
      html += `<tr>${inCell(list, i, "date", "", "date")}${selCell(list, i, "layer", ENUMS.layer, true)}${txtCell(list, i, "value", "Giá trị / bằng chứng đã xảy ra")}${txtCell(list, i, "source", "Biên bản, dashboard, báo cáo…")}${selCell(list, i, "confidence", ENUMS.confidence, true)}${txtCell(list, i, "learning", "")}${selCell(list, i, "decision", ENUMS.decision, true)}${txtCell(list, i, "verifier", "")}${delCell(list, i, 1)}</tr>`;
    } else if (list === "reviews") {
      html += `<tr>${txtCell(list, i, "checkpoint", "Sau 7 ngày…")}${inCell(list, i, "date", "", "date")}${txtCell(list, i, "behavior_evidence", "")}${txtCell(list, i, "output_evidence", "")}${txtCell(list, i, "result_evidence", "")}${txtCell(list, i, "works", "")}${txtCell(list, i, "not_works", "")}${txtCell(list, i, "learning", "")}${txtCell(list, i, "verifier", "")}${delCell(list, i, 1)}</tr>`;
    }
  });
  tbody.innerHTML = html;
}

/* ----- static fields + delegated table input ----- */

const STATIC_MAP = [
  ["f_title", "meta", "title"],
  ["f_owner", "meta", "owner"],
  ["f_stage", "meta", "stage"],
  ["f_mode", "meta", "mode"],
  ["f_updated", "meta", "updated"],
  ["f_goal", "goal", "statement"],
  ["f_goalctx", "goal", "context"],
  ["f_krmetric", "kr", "metric"],
  ["f_krcur", "kr", "current"],
  ["f_krtar", "kr", "target"],
  ["f_krdl", "kr", "deadline"],
  ["f_krcs", "kr", "cs"],
  ["f_soldir", "solution", "direction"],
  ["f_sollogic", "solution", "logic"],
  ["f_risks", null, "risks"],
];

function bindStaticFields() {
  for (const [id, obj, key] of STATIC_MAP) {
    const node = $(id);
    if (!node) continue;
    node.value = obj ? state[obj][key] : state[key];
    const on = () => {
      if (obj) state[obj][key] = node.value;
      else state[key] = node.value;
      if (id === "f_stage") updateStageUI();
      markDirty();
    };
    node.addEventListener("input", on);
    node.addEventListener("change", on);
  }
  $("addOutput").addEventListener("click", () =>
    addRow("outputs", LIMITS.outputs[1], blankOutput),
  );
  $("addBehavior").addEventListener("click", () =>
    addRow("behaviors", LIMITS.behaviors[1], blankBehavior),
  );
  $("addAction").addEventListener("click", () =>
    addRow("actions", 99, blankAction),
  );
  $("addPlan").addEventListener("click", () =>
    addRow("plan", 99, () => blankPlanRow("")),
  );
  $("addObserved").addEventListener("click", () =>
    addRow("observed", 99, blankObserved),
  );
  $("addReview").addEventListener("click", () =>
    addRow("reviews", 99, () => blankReview("")),
  );
}

function addRow(list, max, maker) {
  if (state[list].length >= max) {
    window.alert("Đã đạt giới hạn theo schema (" + max + " dòng).");
    return;
  }
  state[list].push(maker());
  renderRows(list);
  markDirty();
}

/** Resolve a free-text assignee label to a company user id (or drop it). */
function resolveAssignee(row, label) {
  const hit = companyUsers.find((u) => u.name === label.trim());
  if (hit) row.assignee_user_id = hit.id;
  else delete row.assignee_user_id;
}

function onTableInput(e) {
  const t = e.target;
  const l = t.dataset && t.dataset.l;
  if (!l) return;
  const row = state[l][+t.dataset.i];
  if (!row) return;
  const k = t.dataset.k;
  if (k === "behavior_id") {
    row[k] = t.value || null;
  } else {
    row[k] = t.value;
    if (k === "assignee_label") resolveAssignee(row, t.value);
  }
  // Behavior names feed the boxes select — keep options in sync.
  if (l === "behaviors" && (k === "behavior" || k === "actor"))
    renderRows("boxes");
  markDirty();
}

function onTableClick(e) {
  const b = e.target.closest("[data-del]");
  if (!b) return;
  state[b.dataset.del].splice(+b.dataset.i, 1);
  renderRows(b.dataset.del);
  markDirty();
}

function updateStageUI() {
  const stage = state.meta.stage;
  $("stageNote").textContent = STAGE_NOTES[stage];
  const note = $("observedNote");
  const zone = $("observedZone");
  if (!note || !zone) return;
  if (stage === "DRAFT") {
    note.style.display = "block";
    note.textContent =
      "Canvas đang ở stage DRAFT — theo schema 3.0, Observed Evidence sẽ được xuất là “TBD”. Chuyển stage sang PILOTING/VALIDATED khi đã có quan sát thực tế.";
    zone.style.opacity = 0.45;
    zone.style.pointerEvents = "none";
  } else {
    note.style.display = "none";
    zone.style.opacity = 1;
    zone.style.pointerEvents = "auto";
  }
}

/** Push `state` into every field — after load / reload-latest / restore. */
function populateForm() {
  for (const [id, obj, key] of STATIC_MAP) {
    const node = $(id);
    if (node) node.value = obj ? state[obj][key] : state[key];
  }
  renderAllRows();
}

/* ================= Import (explicit only — never auto) ================= */

function applyImported(result) {
  state = result.body;
  populateForm();
  markDirty();
  const rep = $("importReport");
  rep.style.display = "block";
  rep.className = "import-report";
  rep.textContent = result.warnings.length
    ? "Đã nhập — kiểm tra lại các điểm sau:"
    : "Đã nhập — kiểm tra lại nội dung rồi tiếp tục.";
  if (result.warnings.length) {
    const ul = document.createElement("ul");
    result.warnings.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      ul.appendChild(li);
    });
    rep.appendChild(ul);
  }
}

function bindImportUI() {
  $("btnImport").addEventListener("click", () => {
    $("importWrap").classList.add("show");
    $("importText").focus();
    offerLegacyImport();
  });
  $("btnCancelImport").addEventListener("click", () =>
    $("importWrap").classList.remove("show"),
  );
  $("btnDoImport").addEventListener("click", () => {
    const rep = $("importReport");
    try {
      const result = importCanvasText($("importText").value);
      if (
        !window.confirm(
          "Nội dung nhập sẽ THAY THẾ toàn bộ dữ liệu đang điền trên form (và sẽ tự lưu lên máy chủ). Tiếp tục?",
        )
      )
        return;
      applyImported(result);
    } catch (err) {
      rep.style.display = "block";
      rep.className = "import-report err";
      rep.textContent = String(err && err.message ? err.message : err);
    }
  });

  // Legacy local copy — offered ONLY as an explicit, confirmed import.
  function offerLegacyImport() {
    const slot = $("legacyImport");
    if (!slot) return;
    let raw = null;
    try {
      raw = localStorage.getItem(LEGACY_STORE_KEY);
    } catch {
      /* storage may be denied — never fatal */
    }
    slot.replaceChildren();
    if (!raw) return;
    const p = document.createElement("p");
    p.className = "note";
    p.textContent =
      "Tìm thấy một bản lưu cũ trong trình duyệt này (bản Canvas Online trước đây). Bản này KHÔNG được tự tải — bấm nút dưới để nhập nếu muốn.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add";
    btn.textContent = "Nhập bản lưu trên trình duyệt";
    btn.addEventListener("click", () => {
      if (
        !window.confirm(
          "Nhập bản lưu cũ từ trình duyệt và THAY THẾ dữ liệu đang điền (sẽ tự lưu lên máy chủ)?",
        )
      )
        return;
      try {
        applyImported(importCanvasText(raw));
      } catch (err) {
        const rep = $("importReport");
        rep.style.display = "block";
        rep.className = "import-report err";
        rep.textContent = String(err && err.message ? err.message : err);
      }
    });
    slot.append(p, btn);
  }
}

/* ================= Toolbar ================= */

/** Flush pending autosave, then fetch the audited draft export payload. */
async function exportableDraft() {
  if (isDirtyish()) await autosave.flush(() => state);
  if (saveState === "conflict") {
    window.alert(
      "Đang có xung đột chưa xử lý — bản xuất là bản đã lưu trên máy chủ.",
    );
  }
  // A failed flush means the server draft is stale — exporting it would
  // silently omit the user's current edits. Abort like publish does.
  if (saveState === "error" || saveState === "dirty" || saveState === "saving") {
    window.alert("Bản nháp chưa lưu được — bấm “Thử lại” trước khi xuất.");
    return null;
  }
  const out = await exportDraftPreview(canvasId);
  if (!out) {
    window.alert(
      "Không xuất được — canvas chưa có bản nháp hoặc bạn không còn quyền.",
    );
    return null;
  }
  return out;
}

function bindToolbar() {
  $("btnPreview").addEventListener("click", () => {
    $("preview").innerHTML = previewHtml(state, GWP_LOGO);
    $("previewWrap").classList.add("show");
    $("previewWrap").scrollIntoView({ block: "start" });
  });
  $("btnClosePreview").addEventListener("click", () =>
    $("previewWrap").classList.remove("show"),
  );
  // Export buttons go through POST /export-preview — the download is an
  // audited act, and the payload is the server-saved draft (not whatever
  // the tab happens to hold).
  $("btnMd").addEventListener("click", async () => {
    const out = await exportableDraft();
    if (!out) return;
    if (out.warnings?.length) {
      window.alert("Lưu ý khi xuất Markdown:\n- " + out.warnings.join("\n- "));
    }
    // Download the SERVER-rendered Markdown — the artifact the audited
    // warnings actually describe (browser buildMarkdown would diverge).
    download(
      new Blob([out.markdown], { type: "text/markdown" }),
      slug(out.body) + ".md",
    );
  });
  $("btnCopyMd").addEventListener("click", async () => {
    const out = await exportableDraft();
    if (!out) return;
    try {
      await navigator.clipboard.writeText(out.markdown);
      $("btnCopyMd").textContent = "✓ Đã sao chép";
      setTimeout(() => ($("btnCopyMd").textContent = "📋 Sao chép Markdown"), 1500);
    } catch {
      window.alert("Trình duyệt chặn clipboard — hãy dùng nút Markdown (.md).");
    }
  });
  $("btnJson").addEventListener("click", async () => {
    const out = await exportableDraft();
    if (!out) return;
    download(
      new Blob([JSON.stringify(out.body, null, 2)], { type: "application/json" }),
      slug(out.body) + ".json",
    );
  });
  $("btnXlsx").addEventListener("click", async () => {
    const out = await exportableDraft();
    if (!out) return;
    download(buildXlsx(out.body), slug(out.body) + ".xlsx");
  });
  $("btnPdf").addEventListener("click", async () => {
    const out = await exportableDraft();
    if (!out) return;
    $("preview").innerHTML = previewHtml(out.body, GWP_LOGO);
    $("previewWrap").classList.add("show");
    setTimeout(() => window.print(), 60);
  });
  $("btnClear").addEventListener("click", () => {
    if (
      !window.confirm(
        "Xóa toàn bộ nội dung đang điền trên form? Bản trống sẽ tự lưu lên máy chủ — các phiên bản đã chốt trong Lịch sử vẫn giữ nguyên.",
      )
    )
      return;
    const keep = { title: state.meta.title, owner: state.meta.owner };
    state = blankBody();
    state.meta.title = keep.title;
    state.meta.owner = keep.owner;
    populateForm();
    markDirty();
  });
  $("btnPublish").addEventListener("click", publish);
  $("saveRetry").addEventListener("click", () => autosave.retry());
}

/* ================= beforeunload ================= */

function bindUnload() {
  window.addEventListener("beforeunload", (e) => {
    if (!isDirtyish()) return;
    // Does the wire's last body differ from what's on screen? Check BEFORE
    // serializeDraft() — it stamps lastSentBody with the outgoing payload.
    const unsent = !lastSentBody || !deepEqual(state, lastSentBody);
    const payload = serializeDraft();
    // keepalive bodies are capped ~64KiB by the browser — over that the
    // request is rejected synchronously, so only the warning applies.
    // TextEncoder measures BYTES, not JS chars: Vietnamese/emoji-heavy
    // bodies can exceed the cap well under 60k chars.
    const fitsKeepalive = new TextEncoder().encode(payload).length < 60000;
    if (unsent && fitsKeepalive) {
      // Dispatch the newest body SYNCHRONOUSLY at the current revision —
      // never a speculative N+1, and never through flush(): a queued send
      // starts only from a .then() continuation the teardown may not run
      // (and a post-send edit leaves saveState "dirty", not "saving", so a
      // state-label gate would skip this path exactly when it matters).
      //
      // expectedRevision N is CAS-safe in every outcome: the server
      // serializes writers on the company lock + FOR UPDATE + the revision
      // predicate, so whoever commits first takes the N→N+1 slot and every
      // other expectedRevision-N request 409s — this tab's in-flight save,
      // another writer's save, or a lost-ack recommit alike. This request
      // can only land while the server still sits at N, i.e. when nothing
      // else committed — it can never overwrite a concurrent writer.
      putDraft(payload, true).catch(() => {});
    }
    // Keep the serialized pipeline coherent for a CANCELED unload: flush
    // no-ops while frozen, queues behind an in-flight save, and sends
    // immediately when only the debounce timer was armed.
    autosave
      .flush(() => state, fitsKeepalive ? { keepalive: true } : undefined)
      .catch(() => {});
    // The warning stays up whenever the newest body hasn't actually been
    // acknowledged — the unload write is best-effort, never guaranteed.
    e.preventDefault();
    e.returnValue = "";
  });
}

/* ================= Identity list (assignee datalist) ================= */

async function loadCompanyUsers() {
  try {
    // Every directory page — a one-page read silently dropped users >100.
    const all = await apiFetchAll("/users?limit=100");
    companyUsers = all
      .filter((u) => u.status === "active")
      .map((u) => ({ id: u.id, name: u.name }));
    const dl = $("userList");
    if (dl) {
      dl.replaceChildren(
        ...companyUsers.map((u) => {
          const o = document.createElement("option");
          o.value = u.name;
          return o;
        }),
      );
    }
  } catch {
    /* datalist is a convenience — an unavailable directory is not fatal */
  }
}

/* ================= Boot ================= */

function hideLoadNote() {
  const n = $("loadNote");
  if (n) n.hidden = true;
}

function showDenied(message) {
  hideLoadNote();
  const d = $("canvasDenied");
  d.hidden = false;
  d.querySelector("[data-denied-msg]").textContent =
    message ||
    "Bạn không có quyền xem canvas này — hoặc canvas không tồn tại. Nếu bạn vừa được cấp quyền, hãy tải lại trang.";
}

/**
 * No ?canvas= param → the creation flow (gate-review fix): collect name +
 * owner, POST /canvases, then open the editor on the new id. The owner
 * select lists active company users — the subject policy on the chosen
 * owner decides server-side (self for members, subtree for managers,
 * anyone for owner); a denied pick answers 404 and shows here.
 */
async function showCreate(me) {
  hideLoadNote();
  const panel = $("canvasCreate");
  panel.hidden = false;
  const sel = $("createOwner");
  const selfOpt = document.createElement("option");
  selfOpt.value = me.id;
  selfOpt.textContent = `${me.name} (tôi)`;
  sel.append(selfOpt);
  try {
    for (const u of await apiFetchAll("/users?limit=100")) {
      if (u.id === me.id || u.status !== "active") continue;
      const o = document.createElement("option");
      o.value = u.id;
      o.textContent = u.name;
      sel.append(o);
    }
  } catch {
    /* owner list is best-effort — self is always a valid default */
  }
  $("createForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("createErr");
    err.hidden = true;
    const btn = $("createSubmit");
    btn.disabled = true;
    try {
      const res = await apiFetch("/canvases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerUserId: sel.value || me.id,
          name: $("createName").value.trim(),
          body: blankBody(),
        }),
      });
      if (res.status === 201) {
        const created = await res.json();
        location.href = `/canvas-online/?canvas=${encodeURIComponent(created.id)}`;
        return;
      }
      const data = await res.json().catch(() => null);
      err.textContent =
        res.status === 404
          ? "Bạn không có quyền tạo canvas cho người này — hãy chọn chủ sở hữu trong phạm vi của bạn."
          : (data && data.message) || "Không tạo được canvas — thử lại sau.";
      err.hidden = false;
    } catch {
      err.textContent = "Mất kết nối máy chủ — thử lại sau.";
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

async function init() {
  $("brandMark").src = GWP_LOGO;
  const identity = await requireAuth(); // null → redirected to /index.html
  if (!identity) return;

  const params = new URLSearchParams(location.search);
  canvasId = params.get("canvas");
  if (!canvasId) {
    await showCreate(identity.user);
    return;
  }

  const res = await apiFetch(`/canvases/${canvasId}`);
  if (res.status === 404) {
    showDenied();
    return;
  }
  if (!res.ok) {
    showDenied("Không tải được canvas — thử lại sau.");
    return;
  }
  const detail = await res.json();
  const archived = detail.status === "archived";

  let draft = detail.draft;
  if (!draft && archived) {
    // Archived: no draft can be opened (409) — show the head version
    // read-only, or a blank form when nothing was ever published.
    draft = await readOnlyHead(detail);
  }
  if (!draft) {
    // No live draft (e.g. just published elsewhere) — open one; it seeds
    // from the head version or a blank body.
    const dr = await apiFetch(`/canvases/${canvasId}/draft`, {
      method: "POST",
    });
    if (dr.status === 201) {
      draft = await dr.json();
    } else if (dr.status === 409) {
      const again = await apiFetch(`/canvases/${canvasId}`);
      if (again.ok) draft = (await again.json()).draft;
    }
    if (!draft) {
      showDenied("Canvas này không mở được bản nháp — thử lại sau.");
      return;
    }
  }

  revision = draft.revision;
  baseVersionId = draft.baseVersionId;
  state = sanitizeBody(draft.body, [], true);

  setVersionChip(detail.currentVersion);
  renderSteps();
  populateForm();
  hideLoadNote();
  $("editorMain").hidden = false;
  setSaveState("idle");

  historyPanel = createHistoryPanel({
    canvasId,
    panel: $("historyPanel"),
    listEl: $("historyList"),
    viewEl: $("versionView"),
    getDraftRevision: () => revision,
    onRestored: (d) => {
      adoptDraftPointers(d);
      state = sanitizeBody(d.body, [], true);
      populateForm();
      setSaveState("saved");
    },
    onError: (msg) => window.alert(msg),
    download,
  });
  $("btnHistory").addEventListener("click", () => historyPanel.open());

  // Phase 3 — the local-AI card. Apply adopts the returned draft the same
  // way a restore does: pointers advance, the form repopulates, autosave
  // sees a clean saved state. AI never touches publish.
  // Phase 4.3/4.4 — a ?report=<id> deep link (from a coaching report's
  // "Dùng trong Renderer" action) turns the panel's bridge picker on.
  mountAiPanel($("aiCard"), {
    canvasId,
    reportId: params.get("report") || null,
    getDraftRevision: () => revision,
    onApplied: (d) => {
      adoptDraftPointers(d);
      state = sanitizeBody(d.body, [], true);
      populateForm();
      setSaveState("saved");
    },
  });

  // Lifecycle card: rename / transfer owner (owner role) / archive.
  const manage = mountCanvasManage({
    panel: $("managePanel"),
    identity,
    detail,
    beforeArchive: async () => {
      // Settle pending edits first — archive closes every write path.
      if (isDirtyish()) await autosave.flush(() => state);
      return saveState !== "error" && saveState !== "conflict";
    },
    onArchived: () => enterReadOnly(),
  });
  $("btnManage").addEventListener("click", () => manage.toggle());

  bindToolbar();
  bindConflictUI();
  bindImportUI();
  bindUnload();
  $("steps").addEventListener("input", onTableInput);
  $("steps").addEventListener("change", onTableInput);
  $("steps").addEventListener("click", onTableClick);
  loadCompanyUsers();
  if (archived) enterReadOnly();
}

/**
 * Read-only stand-in for the draft of an ARCHIVED canvas that has none:
 * the head version's body (or blank). revision stays null — nothing is
 * ever saved from this view.
 */
async function readOnlyHead(detail) {
  let body = blankBody();
  if (detail.currentVersion) {
    const v = await apiFetch(
      `/canvases/${detail.id}/versions/${detail.currentVersion.id}`,
    );
    if (v.ok) body = (await v.json()).body;
  }
  return { revision: null, baseVersionId: detail.currentVersionId, body };
}

/**
 * Archived canvas → read-only editor. The server already refuses every
 * write with 409 CANVAS_ARCHIVED; this makes that visible up front:
 * autosave frozen, form controls disabled, write actions hidden, AI card
 * hidden. History, preview and export stay available.
 */
function enterReadOnly() {
  readOnly = true;
  autosave.freeze();
  $("archivedBanner").hidden = false;
  for (const id of ["btnClear", "btnPublish", "btnImport"]) {
    const b = $(id);
    if (b) b.hidden = true;
  }
  $("importWrap")?.classList.remove("show");
  $("aiCard").hidden = true;
  for (const root of [$("metaCard"), $("steps")]) {
    for (const c of root.querySelectorAll("input, textarea, select, button")) {
      c.disabled = true;
    }
  }
  const label = $("saveState");
  label.textContent = "Đã lưu trữ — chỉ xem";
  label.dataset.state = "archived";
  $("saveRetry").hidden = true;
}

init();
