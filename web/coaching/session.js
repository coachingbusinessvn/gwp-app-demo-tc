/**
 * web/coaching/session.js — the session card on the coaching report page
 * (task 4.4, spec §6).
 *
 * A coaching session is a record of fact: coach × coachee × time, with an
 * optional linked canvas the actor may read. This module renders the
 * create form and the "session to grade" selector:
 *
 * - Coach defaults to the logged-in user. Only an owner may pick another
 *   coach (on-behalf entry — the server audits it separately); for anyone
 *   else the select is locked to self so impersonation is impossible in
 *   the UI (the server still enforces).
 * - The coachee list is the company directory; the server enforces the
 *   manager/owner write gate — the UI just shows the error code.
 * - Sessions already carrying reports (from the report list) and sessions
 *   created in this page view are offered in a picklist — sessions are
 *   never stored in localStorage; a reload simply means creating or
 *   picking again.
 */
import { apiFetch } from "../api.js";

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

function fmtUser(u) {
  return `${u.name} — ${u.email}`;
}

/**
 * @param host the session card element
 * @param opts {identity, onSession}
 *   onSession(sessionId|null) fires whenever the selected session changes.
 */
export function mountSession(host, { identity, onSession }) {
  const isOwner = identity.roles.includes("owner");

  /* ---- pickers ---- */
  const grid = el("div", "grid3");

  const coachSel = document.createElement("select");
  coachSel.id = "sessionCoach";
  const coachLabel = el("label", null, "Coach");
  coachLabel.setAttribute("for", "sessionCoach");
  const coachWrap = el("div");
  coachWrap.append(coachLabel, coachSel);

  const coacheeSel = document.createElement("select");
  coacheeSel.id = "sessionCoachee";
  const coacheeLabel = el("label", null, "Người được coach");
  coacheeLabel.setAttribute("for", "sessionCoachee");
  const coacheeWrap = el("div");
  coacheeWrap.append(coacheeLabel, coacheeSel);

  const canvasSel = document.createElement("select");
  canvasSel.id = "sessionCanvas";
  const canvasLabel = el("label", null, "Canvas liên quan");
  canvasLabel.setAttribute("for", "sessionCanvas");
  const canvasWrap = el("div");
  canvasWrap.append(canvasLabel, canvasSel);
  canvasWrap.querySelector("label").append(
    Object.assign(el("span", "opt"), { textContent: " (tùy chọn)" }),
  );

  grid.append(coachWrap, coacheeWrap, canvasWrap);

  const dateInput = document.createElement("input");
  dateInput.type = "datetime-local";
  dateInput.id = "sessionWhen";
  // Default "now" in local time for datetime-local.
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  dateInput.value = now.toISOString().slice(0, 16);
  const dateLabel = el("label", null, "Thời điểm phiên");
  dateLabel.setAttribute("for", "sessionWhen");

  const createBtn = el("button", "add", "Tạo phiên mới");
  createBtn.type = "button";

  const status = el("p", "note");
  status.dataset.testid = "session-status";
  status.setAttribute("role", "status");

  /* ---- existing-session picklist ---- */
  const existingSel = document.createElement("select");
  existingSel.id = "sessionExisting";
  const existingLabel = el("label", null, "Phiên đã có báo cáo");
  existingLabel.setAttribute("for", "sessionExisting");
  const existingWrap = el("div");
  existingWrap.append(existingLabel, existingSel);

  const currentNote = el("p", "stage-note");
  currentNote.dataset.testid = "session-current";

  host.append(grid, dateLabel, dateInput, createBtn, status, existingWrap, currentNote);

  /** In-memory session registry — ids → {id, coachUserId, coacheeUserId, label}. */
  const sessions = new Map();
  let currentId = null;
  let users = [];
  let canvases = [];

  function userName(id) {
    const u = users.find((x) => x.id === id);
    return u ? u.name : id.slice(0, 8);
  }

  function refreshCurrent() {
    const s = currentId ? sessions.get(currentId) : null;
    currentNote.textContent = s
      ? `Phiên đang chọn: coach ${userName(s.coachUserId)} → ${userName(s.coacheeUserId)} · ${String(s.occurredAt ?? "").slice(0, 16).replace("T", " ")}`
      : "Chưa chọn phiên — tạo phiên mới hoặc mở một báo cáo từ danh sách.";
    currentNote.style.display = currentId ? "" : "none";
  }

  function refreshExisting() {
    existingSel.replaceChildren(
      Object.assign(el("option"), {
        value: "",
        textContent: "— chọn phiên đã có báo cáo —",
      }),
      ...[...sessions.values()].map((s) =>
        Object.assign(el("option"), {
          value: s.id,
          textContent: `${userName(s.coacheeUserId)} · ${String(s.occurredAt ?? "").slice(0, 10)} · coach ${userName(s.coachUserId)}`,
        }),
      ),
    );
    if (currentId) existingSel.value = currentId;
  }

  /**
   * Select a session as the grading target. `meta` (optional) registers a
   * session seen only as a report-list row — the reports API carries no
   * occurredAt, so callers pass their best-known label fields.
   */
  function selectSession(id, meta) {
    if (!sessions.has(id)) {
      if (!meta) return;
      sessions.set(id, { id, ...meta });
    }
    currentId = id;
    refreshCurrent();
    refreshExisting();
    onSession?.(id);
  }

  existingSel.addEventListener("change", () => {
    if (existingSel.value) selectSession(existingSel.value);
  });

  createBtn.addEventListener("click", async () => {
    status.textContent = "Đang tạo phiên…";
    const payload = {
      coachUserId: coachSel.value,
      coacheeUserId: coacheeSel.value,
      occurredAt: new Date(dateInput.value).toISOString(),
    };
    if (canvasSel.value) payload.canvasId = canvasSel.value;
    const res = await apiFetch("/coaching-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      status.textContent = `Không tạo được phiên: ${await readError(res)}`;
      return;
    }
    const { id } = await res.json();
    sessions.set(id, {
      id,
      coachUserId: payload.coachUserId,
      coacheeUserId: payload.coacheeUserId,
      occurredAt: payload.occurredAt,
    });
    selectSession(id);
    status.textContent = "Phiên đã tạo — sẵn sàng chấm.";
  });

  /** Load the pickers. Resolves when directory + canvases are in. */
  const ready = (async () => {
    const [usersRes, canvasRes] = await Promise.all([
      apiFetch("/users?limit=100"),
      apiFetch("/canvases?limit=100"),
    ]);
    if (usersRes.ok) {
      users = (await usersRes.json()).items.filter(
        (u) => u.status === "active",
      );
    }
    if (canvasRes.ok) {
      canvases = (await canvasRes.json()).items.filter(
        (c) => c.status === "active",
      );
    }

    coachSel.replaceChildren(
      ...users.map((u) =>
        Object.assign(el("option"), { value: u.id, textContent: fmtUser(u) }),
      ),
    );
    coachSel.value = identity.user.id;
    // Non-owner may only coach as themselves — lock the select.
    if (!isOwner) coachSel.disabled = true;

    coacheeSel.replaceChildren(
      ...users
        .filter((u) => u.id !== identity.user.id)
        .map((u) =>
          Object.assign(el("option"), {
            value: u.id,
            textContent: fmtUser(u),
          }),
        ),
    );

    canvasSel.replaceChildren(
      Object.assign(el("option"), { value: "", textContent: "—" }),
      ...canvases.map((c) =>
        Object.assign(el("option"), { value: c.id, textContent: c.name }),
      ),
    );
    refreshCurrent();
  })().catch(() => {
    status.textContent = "Không tải được danh sách người dùng — thử tải lại trang.";
  });

  return {
    ready,
    users: () => users,
    canvases: () => canvases,
    currentSessionId: () => currentId,
    selectSession,
    /** Feed sessions seen elsewhere (report list rows carry session ids). */
    registerSession(s) {
      if (s && s.id && !sessions.has(s.id)) {
        sessions.set(s.id, s);
        refreshExisting();
      }
    },
    userName,
  };
}
