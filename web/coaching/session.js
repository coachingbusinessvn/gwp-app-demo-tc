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
 *   manager/owner write gate — the UI shows a friendly explanation.
 * - The picklist is GET /coaching-sessions (every page): the sessions the
 *   server lets this user see — owner: the company; anyone else: sessions
 *   they coach or created. A session without a report therefore survives
 *   a reload and can be resumed. Sessions are never kept in localStorage.
 */
import { apiFetch, apiFetchAll } from "../api.js";
import { readFriendlyError } from "../ai/status.js";

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmtUser(u) {
  return `${u.name} — ${u.email}`;
}

function fmtWhen(iso) {
  return String(iso ?? "").slice(0, 16).replace("T", " ");
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
  existingSel.dataset.testid = "session-existing";
  const existingLabel = el("label", null, "Tiếp tục một phiên đã có");
  existingLabel.setAttribute("for", "sessionExisting");
  const existingWrap = el("div");
  existingWrap.append(existingLabel, existingSel);

  const currentNote = el("p", "stage-note");
  currentNote.dataset.testid = "session-current";

  host.append(grid, dateLabel, dateInput, createBtn, status, existingWrap, currentNote);

  /**
   * In-memory session registry — id → {id, coachUserId, coacheeUserId,
   * occurredAt}. Map insertion order is the display order (newest first
   * from the server; sessions created here are re-inserted at the top).
   */
  let sessions = new Map();
  /** Session ids that already carry at least one visible report. */
  let reported = new Set();
  let currentId = null;
  let directory = []; // every user (names for historical sessions)
  let users = []; // active users (pickers)
  let canvases = [];

  function userName(id) {
    const u = directory.find((x) => x.id === id);
    return u ? u.name : id.slice(0, 8);
  }

  function refreshCurrent() {
    const s = currentId ? sessions.get(currentId) : null;
    currentNote.textContent = s
      ? `Phiên đang chọn: coach ${userName(s.coachUserId)} → ${userName(s.coacheeUserId)} · ${fmtWhen(s.occurredAt)}`
      : "Chưa chọn phiên — tạo phiên mới hoặc chọn một phiên đã có.";
    currentNote.style.display = currentId ? "" : "none";
  }

  function sessionLabel(s) {
    const tag = reported.has(s.id) ? "đã có báo cáo" : "chưa có báo cáo";
    return `${userName(s.coacheeUserId)} · ${fmtWhen(s.occurredAt)} · coach ${userName(s.coachUserId)} · ${tag}`;
  }

  function refreshExisting() {
    existingSel.replaceChildren(
      Object.assign(el("option"), {
        value: "",
        textContent:
          sessions.size > 0
            ? `— chọn phiên (${sessions.size}) —`
            : "— chưa có phiên nào —",
      }),
      ...[...sessions.values()].map((s) =>
        Object.assign(el("option"), {
          value: s.id,
          textContent: sessionLabel(s),
        }),
      ),
    );
    existingSel.disabled = sessions.size === 0;
    if (currentId) existingSel.value = currentId;
  }

  /**
   * Select a session as the grading target. `meta` (optional) registers a
   * session seen only as a report-list row (e.g. a report shared with a
   * user who is neither coach nor creator — not in their session list).
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
    if (!coacheeSel.value) {
      status.textContent = "Chọn người được coach trước khi tạo phiên.";
      return;
    }
    status.textContent = "Đang tạo phiên…";
    createBtn.disabled = true;
    const payload = {
      coachUserId: coachSel.value,
      coacheeUserId: coacheeSel.value,
      occurredAt: new Date(dateInput.value).toISOString(),
    };
    if (canvasSel.value) payload.canvasId = canvasSel.value;
    try {
      const res = await apiFetch("/coaching-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // 404 here is the server's uniform denial: the coachee is not in
        // the actor's current subtree (or the canvas is not readable).
        const err = await readFriendlyError(res);
        status.textContent =
          res.status === 404
            ? "Không tạo được phiên: bạn chỉ tạo được phiên cho người mình đang quản lý (và chỉ liên kết canvas mình xem được)."
            : `Không tạo được phiên: ${err.message}`;
        return;
      }
      const { id } = await res.json();
      // Newest first — put the fresh session at the top of the picklist.
      sessions = new Map([
        [
          id,
          {
            id,
            coachUserId: payload.coachUserId,
            coacheeUserId: payload.coacheeUserId,
            occurredAt: payload.occurredAt,
          },
        ],
        ...sessions,
      ]);
      selectSession(id);
      status.textContent = "Phiên đã tạo — sẵn sàng chấm.";
    } catch {
      status.textContent = "Mất kết nối máy chủ — thử lại sau.";
    } finally {
      createBtn.disabled = false;
    }
  });

  /** Load directory, canvases and the user's sessions (every page). */
  const ready = (async () => {
    const [usersR, canvasR, sessionsR] = await Promise.allSettled([
      apiFetchAll("/users?limit=100"),
      apiFetchAll("/canvases?limit=100"),
      apiFetchAll("/coaching-sessions?limit=100"),
    ]);
    if (usersR.status === "fulfilled") {
      directory = usersR.value;
      users = directory.filter((u) => u.status === "active");
    } else {
      status.textContent =
        "Không tải được danh sách người dùng — thử tải lại trang.";
    }
    if (canvasR.status === "fulfilled") {
      canvases = canvasR.value.filter((c) => c.status === "active");
    }
    if (sessionsR.status === "fulfilled") {
      for (const s of sessionsR.value) {
        if (!sessions.has(s.id)) sessions.set(s.id, s);
      }
    } else {
      status.textContent =
        "Không tải được danh sách phiên coaching — thử tải lại trang.";
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
    refreshExisting();
  })().catch(() => {
    status.textContent = "Không tải được dữ liệu phiên — thử tải lại trang.";
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
    /** Mark which sessions already carry a visible report (labels only). */
    markReported(sessionIds) {
      reported = new Set(sessionIds);
      refreshExisting();
    },
    userName,
  };
}
