/**
 * web/coaching/grader.js — the ORACLE grading card (task 4.4, spec §6/§7.3).
 *
 * Same run-loop discipline as the canvas AI panel, adapted to the oracle
 * contract:
 *
 * - The transcript lives in the textarea ONLY — never localStorage, never
 *   a persisted field. It is cleared the moment a run ends (done, error,
 *   cancel) and the page warns on unload while text is present.
 * - The consent checkbox arms ONE run and resets when the run ends; it is
 *   locked (with an explanation) while GET /ai/status says AI is not
 *   configured or switched off (spec §7.1).
 * - Oracle runs never stream deltas (half-validated reports must not
 *   leak) — the event feed is status-only, then the preview is fetched.
 * - "Lưu báo cáo" is an explicit POST /reports carrying ids only — the
 *   server persists its own validated preview; client bytes are never a
 *   report body.
 */
import { apiFetch } from "../api.js";
import { readEvents } from "../ai/stream.js";
import {
  friendlyError,
  mountAiAvailability,
  readFriendlyError,
  runStatusLabel,
} from "../ai/status.js";
import { renderOracleReport } from "./report.js";

const TRANSCRIPT_MAX_BYTES = 1024 * 1024; // 1 MiB — mirrors AI_INPUT_MAX_BYTES

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Codes that mean "AI itself is unusable" — re-check the banner. */
const AVAILABILITY_CODES = new Set([
  "AI_NOT_CONFIGURED",
  "AI_DISABLED",
  "AI_KEY_DECRYPT_FAILED",
]);

async function readError(res) {
  return (await readFriendlyError(res)).message;
}

/**
 * @param host the grader card element
 * @param opts {getSessionId, onSaved}
 *   getSessionId() → the currently selected session id (or null);
 *   onSaved(report) fires after an explicit save lands.
 */
export function mountGrader(host, { getSessionId, onSaved }) {
  const taLabel = el("label", null, "Transcript phiên coaching");
  taLabel.setAttribute("for", "graderTranscript");
  const transcript = document.createElement("textarea");
  transcript.id = "graderTranscript";
  transcript.style.minHeight = "160px";
  transcript.placeholder =
    "Dán transcript phiên coaching (định dạng thoại Coach:/Coachee:…). Tối đa 1 MiB — nội dung không được lưu lại.";

  const sizeNote = el("p", "note");
  transcript.addEventListener("input", () => {
    const bytes = new TextEncoder().encode(transcript.value).length;
    sizeNote.textContent =
      bytes > 0
        ? `${(bytes / 1024).toFixed(1)} KiB / 1024 KiB${bytes > TRANSCRIPT_MAX_BYTES ? " — vượt giới hạn" : ""}`
        : "";
  });

  const consentLabel = el("label", "ai-consent");
  const consent = document.createElement("input");
  consent.type = "checkbox";
  consent.id = "graderConsent";
  consentLabel.append(
    consent,
    document.createTextNode(" Đồng ý xử lý nội dung bằng AI nội bộ"),
  );

  const gradeBtn = el("button", "add", "Chấm phiên");
  gradeBtn.type = "button";
  gradeBtn.disabled = true;
  const cancelBtn = el("button", "add", "Hủy chấm");
  cancelBtn.type = "button";
  cancelBtn.hidden = true;

  const status = el("p", "note");
  status.dataset.testid = "grader-status";
  status.setAttribute("role", "status");

  const previewHost = el("div");
  previewHost.dataset.testid = "grader-preview";

  const saveBtn = el("button", "act", "Lưu báo cáo");
  saveBtn.type = "button";
  saveBtn.hidden = true;

  const btnRow = el("div");
  btnRow.style.marginTop = "10px";
  btnRow.append(gradeBtn, document.createTextNode(" "), cancelBtn);

  host.append(
    taLabel,
    transcript,
    sizeNote,
    consentLabel,
    btnRow,
    status,
    previewHost,
    saveBtn,
  );

  let activeAbort = null;
  let currentRunId = null;
  let cancelRequested = false;
  let aiAvailable = true; // flipped by the /ai/status check below

  function clearTranscript() {
    transcript.value = "";
    sizeNote.textContent = "";
  }

  function resetConsent() {
    consent.checked = false;
    refreshGradeState();
  }

  function refreshGradeState() {
    gradeBtn.disabled =
      !aiAvailable || !consent.checked || activeAbort !== null || !getSessionId();
  }

  // Up-front availability (spec §7.1): an unusable AI is explained before
  // anyone pastes a transcript or consents; the consent box stays locked.
  const availability = mountAiAvailability(host, {
    before: taLabel,
    onChange: (available) => {
      aiAvailable = available;
      consent.disabled = !available;
      if (!available) consent.checked = false;
      refreshGradeState();
    },
  });
  void availability.check();

  consent.addEventListener("change", refreshGradeState);

  function setRunning(on) {
    cancelBtn.hidden = !on;
    if (!on) activeAbort = null;
    refreshGradeState();
  }

  /** Leaving with text in the box warns — nothing is auto-persisted. */
  window.addEventListener("beforeunload", (e) => {
    if (transcript.value.trim().length > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  async function showPreview(runId) {
    const res = await apiFetch(`/ai/runs/${runId}/preview`);
    previewHost.replaceChildren();
    if (res.status === 410) {
      status.textContent =
        "Preview đã hết hạn (TTL 15 phút hoặc restart) — chạy lại grader.";
      return;
    }
    if (!res.ok) {
      status.textContent = `Không đọc được preview: ${await readError(res)}`;
      return;
    }
    const { value } = await res.json();
    if (value?.kind !== "oracle") {
      status.textContent = "Preview không phải report ORACLE.";
      return;
    }
    if (value.output) {
      previewHost.append(renderOracleReport(value.output));
      saveBtn.hidden = false;
      saveBtn.dataset.runId = runId;
      status.textContent =
        "Chấm xong — kiểm tra kỹ trước khi lưu. Điểm AI hỗ trợ phát triển coach, không phải quyết định nhân sự.";
    } else {
      const box = el("div", "oracle-issues");
      box.append(el("b", null, "Report không hợp lệ — không thể lưu:"));
      const ul = document.createElement("ul");
      for (const issue of value.issues ?? []) {
        ul.append(el("li", null, `${issue.code}: ${issue.message}`));
      }
      box.append(ul);
      previewHost.append(box);
      saveBtn.hidden = true;
      status.textContent = "Grader trả về output không hợp lệ — chạy lại.";
    }
  }

  async function run() {
    const sessionId = getSessionId();
    if (!sessionId) {
      status.textContent = "Chọn hoặc tạo một phiên trước khi chấm.";
      return;
    }
    const bytes = new TextEncoder().encode(transcript.value).length;
    if (bytes === 0) {
      status.textContent = "Transcript đang trống.";
      return;
    }
    if (bytes > TRANSCRIPT_MAX_BYTES) {
      status.textContent = "Transcript vượt 1 MiB — hãy chia nhỏ theo ranh giới phiên.";
      return;
    }

    previewHost.replaceChildren();
    saveBtn.hidden = true;
    status.textContent = "Đang khởi chạy grader…";

    const start = await apiFetch("/ai/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant: "oracle",
        sessionId,
        transcript: transcript.value,
        consent: true,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    if (!start.ok) {
      const err = await readFriendlyError(start);
      status.textContent = `Không chạy được: ${err.message}`;
      resetConsent();
      if (AVAILABILITY_CODES.has(err.code)) void availability.check();
      return;
    }
    const { runId } = await start.json();
    currentRunId = runId;
    cancelRequested = false;
    activeAbort = new AbortController();
    setRunning(true);

    const ev = await apiFetch(`/ai/runs/${runId}/events`);
    if (!ev.ok || !ev.body) {
      status.textContent = `Không theo dõi được run: ${await readError(ev)}`;
      setRunning(false);
      resetConsent();
      return;
    }

    let terminal = false;
    try {
      await readEvents(
        ev,
        (e) => {
          if (e.type === "status" && typeof e.status === "string") {
            status.textContent = `Trạng thái: ${runStatusLabel(e.status)}`;
          } else if (e.type === "done") {
            terminal = true;
            void showPreview(runId);
          } else if (e.type === "error") {
            terminal = true;
            status.textContent = `Run lỗi: ${friendlyError(e.code ?? "AI_INTERNAL")} (${e.code ?? "AI_INTERNAL"})`;
          }
          // Oracle emits no delta frames by design — nothing to render.
        },
        activeAbort.signal,
      );
    } catch {
      /* aborted locally — the cancel handler owns the status line */
    }

    setRunning(false);
    resetConsent();
    // The transcript's job is done regardless of outcome — never keep it.
    clearTranscript();
    if (cancelRequested) {
      status.textContent = "Đã hủy — không có report nào được tạo.";
      currentRunId = null;
      return;
    }
    if (!terminal) {
      // Stream closed without a terminal event — re-read once so the
      // status line never lies (same pattern as the canvas AI panel).
      const g = await apiFetch(`/ai/runs/${runId}`);
      if (g.ok) {
        const r = await g.json();
        if (r.status === "succeeded") {
          void showPreview(runId);
        } else if (r.status === "cancelled") {
          status.textContent = "Đã hủy — không có report nào được tạo.";
        } else {
          status.textContent = `Trạng thái: ${runStatusLabel(r.status)}`;
        }
      }
    }
    currentRunId = null;
  }

  gradeBtn.addEventListener("click", () => {
    void run();
  });
  cancelBtn.addEventListener("click", async () => {
    cancelRequested = true;
    const runId = currentRunId;
    if (runId) {
      await apiFetch(`/ai/runs/${runId}/cancel`, { method: "POST" }).catch(
        () => {},
      );
    }
    activeAbort?.abort();
    clearTranscript();
    status.textContent = "Đã hủy — không có report nào được tạo.";
  });

  saveBtn.addEventListener("click", async () => {
    const sessionId = getSessionId();
    const runId = saveBtn.dataset.runId;
    if (!sessionId || !runId) return;
    saveBtn.disabled = true;
    status.textContent = "Đang lưu báo cáo…";
    const res = await apiFetch("/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        runId,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    saveBtn.disabled = false;
    if (res.status === 410) {
      status.textContent =
        "Preview đã hết hạn — chạy lại grader rồi lưu (báo cáo chỉ lưu từ preview còn hiệu lực).";
      return;
    }
    if (!res.ok) {
      status.textContent = `Không lưu được: ${await readError(res)}`;
      return;
    }
    const saved = await res.json();
    saveBtn.hidden = true;
    status.textContent = `Đã lưu báo cáo v${saved.reportVersion} — bất biến, chỉ đọc được theo quyền.`;
    onSaved?.(saved);
  });

  return { refreshGradeState };
}
