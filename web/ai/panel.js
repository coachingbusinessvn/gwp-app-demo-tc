/**
 * web/ai/panel.js — the AI card on the canvas editor (task 3.6).
 *
 * The full run loop lives here: consent gate → POST /ai/runs → fetch-SSE
 * progress (readEvents — EventSource cannot send Bearer) → staged
 * preview → explicit apply. Design rules from spec §7.3:
 *
 * - The consent checkbox ARMS one run and resets the moment the run ends
 *   (done/error/cancel) — AI use is a deliberate per-run decision.
 * - Error surfaces show the server's stable code + request id, never a
 *   provider detail or credential.
 * - Apply sends only {expectedRevision, acceptedWarnings} — generated
 *   content is never client-supplied; the server applies its own preview.
 * - A successful apply calls back into the editor which adopts the
 *   returned draft — the AI never publishes.
 */
import { apiFetch } from "../api.js";
import { readEvents } from "./stream.js";
import { renderAiPreview } from "./preview.js";

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function readError(res) {
  const data = await res.json().catch(() => null);
  const code = typeof data?.code === "string" ? data.code : "REQUEST_FAILED";
  const req =
    typeof data?.requestId === "string" ? ` · req ${data.requestId}` : "";
  return `${code}${req}`;
}

/**
 * @param host the <section class="card"> container in canvas-online
 * @param opts {canvasId, getDraftRevision, onApplied, reportId}
 *   onApplied(draftDto) lets the editor adopt the new revision/body.
 *   reportId (optional, task 4.4) is a coaching report the actor may read —
 *   when set, the panel offers the whitelisted-field picker and sends
 *   reportId+reportFields on renderer runs (the report→Renderer bridge;
 *   the server re-checks both ACLs and extracts server-side).
 */
export function mountAiPanel(host, {
  canvasId,
  getDraftRevision,
  onApplied,
  reportId = null,
}) {
  if (!host) return;

  const grid = el("div", "grid2");
  const assistant = document.createElement("select");
  assistant.id = "aiAssistant";
  for (const [v, label] of [
    ["renderer", "Renderer — cập nhật canvas từ ghi chú phiên"],
    ["coach", "Coach — chấm rubric & gợi ý (chỉ đọc, không sửa)"],
  ]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    assistant.append(o);
  }
  const aLabel = el("label", null, "Trợ lý");
  aLabel.setAttribute("for", "aiAssistant");
  const aWrap = el("div");
  aWrap.append(aLabel, assistant);
  grid.append(aWrap, el("div"));

  const notesLabel = el("label", null, "Ghi chú phiên / báo cáo ORACLE");
  notesLabel.setAttribute("for", "aiNotes");
  const notes = document.createElement("textarea");
  notes.id = "aiNotes";
  notes.placeholder =
    "Dán ghi chú phiên coaching hoặc báo cáo ORACLE — nội dung chỉ gửi tới endpoint AI nội bộ đã cấu hình.";

  /* ---- report→Renderer bridge field picker (only when opened with one) ---- */
  let bridgeBox = null;
  const fieldChecks = [];
  if (reportId) {
    bridgeBox = el("div");
    bridgeBox.dataset.testid = "report-bridge";
    bridgeBox.hidden = true;
    bridgeBox.append(
      el(
        "p",
        "note",
        "Kèm khuyến nghị từ coaching report đã chọn — chỉ các mục đánh dấu được đưa vào prompt (điểm số và trích dẫn transcript không bao giờ đi qua).",
      ),
    );
    for (const [field, label] of [
      ["priorities", "Ưu tiên cải thiện"],
      ["followUp", "Follow-up"],
      ["nextSession", "Chuẩn bị phiên tiếp theo"],
    ]) {
      const l = el("label", "ai-consent");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.field = field;
      fieldChecks.push(cb);
      l.append(cb, document.createTextNode(` ${label}`));
      bridgeBox.append(l);
    }
  }

  const consentLabel = el("label", "ai-consent");
  const consent = document.createElement("input");
  consent.type = "checkbox";
  consent.id = "aiConsent";
  consentLabel.append(
    consent,
    document.createTextNode(" Đồng ý xử lý nội dung bằng AI nội bộ"),
  );

  const runBtn = el("button", "add", "Chạy AI");
  runBtn.type = "button";
  runBtn.id = "aiRun";
  runBtn.disabled = true;
  const cancelBtn = el("button", "add", "Hủy chạy AI");
  cancelBtn.type = "button";
  cancelBtn.id = "aiCancel";
  cancelBtn.hidden = true;

  const status = el("p", "note");
  status.id = "aiStatus";
  status.dataset.testid = "ai-status";
  status.setAttribute("role", "status");

  const streamBox = document.createElement("pre");
  streamBox.className = "ai-stream";
  streamBox.id = "aiStream";
  streamBox.dataset.testid = "ai-stream";
  streamBox.hidden = true;

  const previewHost = el("div");
  previewHost.id = "aiPreview";

  const btnRow = el("div");
  btnRow.style.marginTop = "10px";
  btnRow.append(runBtn, document.createTextNode(" "), cancelBtn);

  host.append(
    grid,
    notesLabel,
    notes,
    ...(bridgeBox ? [bridgeBox] : []),
    consentLabel,
    btnRow,
    status,
    streamBox,
    previewHost,
  );

  // The bridge is renderer-only — the picker appears only for it.
  if (bridgeBox) {
    const syncBridge = () => {
      bridgeBox.hidden = assistant.value !== "renderer";
    };
    assistant.addEventListener("change", syncBridge);
    syncBridge();
  }

  let activeAbort = null;
  let currentRunId = null;
  let currentPreview = null; // {value, base}
  let cancelRequested = false;

  function resetConsent() {
    consent.checked = false;
    runBtn.disabled = true;
  }
  consent.addEventListener("change", () => {
    runBtn.disabled = !consent.checked || activeAbort !== null;
  });

  function setRunning(on) {
    cancelBtn.hidden = !on;
    runBtn.disabled = on || !consent.checked;
    if (!on) activeAbort = null;
  }

  async function showPreview(runId) {
    const res = await apiFetch(`/ai/runs/${runId}/preview`);
    if (res.status === 410) {
      status.textContent = "Preview đã hết hạn — chạy lại.";
      return;
    }
    if (!res.ok) {
      status.textContent = `Không đọc được preview: ${await readError(res)}`;
      return;
    }
    const body = await res.json();
    currentPreview = body;
    renderAiPreview(previewHost, body.value, {
      onApply: (acceptedWarnings) => apply(runId, acceptedWarnings),
    });
  }

  async function apply(runId, acceptedWarnings) {
    status.textContent = "Đang áp dụng…";
    const res = await apiFetch(`/ai/runs/${runId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision:
          currentPreview?.base?.draftRevision ?? getDraftRevision(),
        acceptedWarnings,
      }),
    });
    if (!res.ok) {
      status.textContent = `Không áp dụng được: ${await readError(res)}`;
      return;
    }
    const draft = await res.json();
    status.textContent = "Đã áp dụng vào bản nháp — kiểm tra lại form.";
    previewHost.replaceChildren();
    onApplied?.(draft);
  }

  async function run() {
    previewHost.replaceChildren();
    currentPreview = null;
    streamBox.replaceChildren();
    streamBox.hidden = true;
    status.textContent = "Đang khởi chạy…";

    // The bridge attaches the report id + the user's field selection —
    // never report content. The server extracts whitelist prose itself.
    const bridgeFields =
      reportId && assistant.value === "renderer"
        ? fieldChecks.filter((c) => c.checked).map((c) => c.dataset.field)
        : [];
    const start = await apiFetch("/ai/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant: assistant.value,
        canvasId,
        notes: notes.value,
        consent: true,
        idempotencyKey: crypto.randomUUID(),
        ...(bridgeFields.length > 0
          ? { reportId, reportFields: bridgeFields }
          : {}),
      }),
    });
    if (!start.ok) {
      status.textContent = `Không chạy được: ${await readError(start)}`;
      resetConsent();
      return;
    }
    const { runId } = await start.json();
    currentRunId = runId;
    cancelRequested = false;
    activeAbort = new AbortController();
    setRunning(true);
    streamBox.hidden = false;

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
          if (e.type === "delta" && typeof e.text === "string") {
            streamBox.append(document.createTextNode(e.text));
            streamBox.scrollTop = streamBox.scrollHeight;
          } else if (e.type === "status" && typeof e.status === "string") {
            status.textContent = `Trạng thái: ${e.status}`;
          } else if (e.type === "done") {
            terminal = true;
            status.textContent = "Hoàn thành — xem đề xuất bên dưới.";
            void showPreview(runId);
          } else if (e.type === "error") {
            terminal = true;
            status.textContent = `Run lỗi: ${e.code ?? "AI_INTERNAL"}`;
          }
        },
        activeAbort.signal,
      );
    } catch {
      /* aborted locally — the cancel handler owns the status line */
    }

    setRunning(false);
    resetConsent();
    if (cancelRequested) {
      status.textContent = "Đã hủy — không có đề xuất nào được lưu.";
      currentRunId = null;
      return;
    }
    if (!terminal) {
      // Stream closed without a terminal event (a cancel can race the
      // last frame) — re-read the run once so the status line never lies.
      const g = await apiFetch(`/ai/runs/${runId}`);
      if (g.ok) {
        const r = await g.json();
        if (r.status === "succeeded") {
          status.textContent = "Hoàn thành — xem đề xuất bên dưới.";
          void showPreview(runId);
        } else if (r.status === "cancelled") {
          status.textContent = "Đã hủy — không có đề xuất nào được lưu.";
        } else {
          status.textContent = `Trạng thái: ${r.status}`;
        }
      }
    }
    currentRunId = null;
  }

  runBtn.addEventListener("click", () => {
    void run();
  });
  cancelBtn.addEventListener("click", async () => {
    cancelRequested = true;
    const runId = currentRunId;
    // Server-side cancel first — the abort signal on the SSE reader then
    // drops the stream (which the server also treats as a cancel).
    if (runId) {
      await apiFetch(`/ai/runs/${runId}/cancel`, { method: "POST" }).catch(
        () => {},
      );
    }
    activeAbort?.abort();
    status.textContent = "Đã hủy — không có đề xuất nào được lưu.";
  });
}
