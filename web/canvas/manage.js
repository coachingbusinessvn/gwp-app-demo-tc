/**
 * web/canvas/manage.js — the "Quản lý canvas" card on the editor:
 * rename, transfer owner, archive.
 *
 * Every action goes through the real lifecycle API and the server stays
 * the authority — the UI only explains:
 *
 * - Rename: PATCH /canvases/:id {name}. Same gate as any canvas edit
 *   (self / owner role / manager over the owner's subtree). Changes the
 *   record name shown in lists and the dashboard; the in-form "Tên canvas"
 *   (meta.title) is separate draft content.
 * - Transfer: POST /canvases/:id/transfer {newOwnerId}. Owner role only
 *   (spec §3/§4) — other roles see why the control is unavailable. The
 *   picker lists ACTIVE users (every directory page). A confirm dialog
 *   spells out the permission impact before anything is sent.
 * - Unarchive: POST /canvases/:id/unarchive (same gate as archive) —
 *   confirmed, then the editor reloads into the writable state.
 * - Archive: POST /canvases/:id/archive. A confirm dialog explains the
 *   consequences (read-only, history kept, no in-app undo). Pending
 *   autosave is flushed first so nothing typed is lost.
 *
 * Dynamic strings render through textContent only — names are user data.
 */
import { apiFetch, apiFetchAll } from "../api.js";
import { readFriendlyError } from "../ai/status.js";

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(label, cls, id) {
  const b = el("button", cls, label);
  b.type = "button";
  if (id) b.id = id;
  return b;
}

/**
 * Modal confirm built on <dialog> — explicit consequences as a list, a
 * labelled confirm button, Esc/Hủy cancel. Resolves true only on confirm.
 */
export function confirmDialog({ title, intro, lines, confirmLabel, testid }) {
  return new Promise((resolve) => {
    const dlg = el("dialog", "confirm-dialog");
    if (testid) dlg.dataset.testid = testid;
    dlg.setAttribute("aria-labelledby", `${testid || "confirm"}-title`);
    const h = el("h3", null, title);
    h.id = `${testid || "confirm"}-title`;
    dlg.append(h);
    if (intro) dlg.append(el("p", null, intro));
    const ul = el("ul");
    for (const line of lines) ul.append(el("li", null, line));
    dlg.append(ul);
    const row = el("div", "confirm-actions");
    const cancel = button("Hủy", "ghost");
    const ok = button(confirmLabel, "danger");
    row.append(cancel, ok);
    dlg.append(row);
    document.body.append(dlg);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(v);
    };
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      done(false);
    });
    dlg.showModal();
    cancel.focus();
  });
}

const STATUS_LABEL = { active: "Đang hoạt động", archived: "Đã lưu trữ" };

/**
 * @param opts
 *   panel        section[data-testid=manage-panel]
 *   identity     {user:{id,name}, roles:[]} from requireAuth
 *   detail       the CanvasDto from GET /canvases/:id
 *   beforeArchive() → Promise<boolean>  settle pending edits; false aborts
 *   onChanged(dto)    any successful lifecycle op (new detail)
 *   onArchived(dto)   after archive succeeds — editor goes read-only
 *   onUnarchived(dto) after unarchive succeeds — editor reopens writable
 */
export function mountCanvasManage({
  panel,
  identity,
  detail,
  beforeArchive,
  onChanged,
  onArchived,
  onUnarchived,
}) {
  let canvas = detail;
  const isOwnerRole = identity.roles.includes("owner");
  const body = panel.querySelector("[data-manage-body]") ?? panel;

  /* ---- summary ---- */
  const summary = el("dl", "manage-summary");
  const nameDd = el("dd");
  nameDd.dataset.testid = "manage-name";
  const ownerDd = el("dd");
  ownerDd.dataset.testid = "manage-owner";
  const statusDd = el("dd");
  statusDd.dataset.testid = "manage-status";
  summary.append(
    el("dt", null, "Tên canvas"),
    nameDd,
    el("dt", null, "Chủ sở hữu"),
    ownerDd,
    el("dt", null, "Trạng thái"),
    statusDd,
  );

  const status = el("p", "note");
  status.dataset.testid = "manage-status-line";
  status.setAttribute("role", "status");

  /* ---- rename ---- */
  const renameBox = el("div", "manage-block");
  const renameLabel = el("label", null, "Đổi tên canvas");
  renameLabel.setAttribute("for", "manageName");
  const renameRow = el("div", "manage-row");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "manageName";
  nameInput.maxLength = 200;
  nameInput.required = true;
  const renameBtn = button("Lưu tên", "add", "manageRename");
  renameRow.append(nameInput, renameBtn);
  renameBox.append(
    renameLabel,
    renameRow,
    el(
      "p",
      "note",
      "Tên này hiển thị trong danh sách canvas và bảng theo dõi. “Tên canvas / đội / dự án” trong form là nội dung bản nháp, đổi riêng.",
    ),
  );

  /* ---- transfer ---- */
  const transferBox = el("div", "manage-block");
  const transferLabel = el("label", null, "Chuyển chủ sở hữu");
  transferLabel.setAttribute("for", "manageOwner");
  const transferRow = el("div", "manage-row");
  const ownerSel = document.createElement("select");
  ownerSel.id = "manageOwner";
  const transferBtn = button("Chuyển chủ sở hữu", "add", "manageTransfer");
  transferRow.append(ownerSel, transferBtn);
  const transferNote = el("p", "note");
  transferBox.append(transferLabel, transferRow, transferNote);

  /* ---- archive ---- */
  const archiveBox = el("div", "manage-block");
  const archiveBtn = button("Lưu trữ canvas", "danger-outline", "manageArchive");
  const unarchiveBtn = button("Bỏ lưu trữ", "add", "manageUnarchive");
  unarchiveBtn.dataset.testid = "manage-unarchive";
  archiveBox.append(
    el("label", null, "Lưu trữ"),
    el(
      "p",
      "note",
      "Lưu trữ khi canvas không còn dùng: chuyển sang chỉ xem, lịch sử phiên bản giữ nguyên. Có thể bỏ lưu trữ để mở lại bất cứ lúc nào.",
    ),
    archiveBtn,
    unarchiveBtn,
  );

  body.append(summary, renameBox, transferBox, archiveBox, status);

  let activeUsers = [];
  let usersLoaded = false;

  function render() {
    const archived = canvas.status === "archived";
    nameDd.textContent = canvas.name;
    ownerDd.textContent = canvas.ownerName || canvas.ownerUserId.slice(0, 8);
    statusDd.textContent = STATUS_LABEL[canvas.status] ?? canvas.status;
    if (document.activeElement !== nameInput) nameInput.value = canvas.name;

    for (const c of [nameInput, renameBtn, ownerSel, transferBtn, archiveBtn]) {
      c.disabled = archived;
    }
    if (!isOwnerRole) {
      ownerSel.disabled = true;
      transferBtn.disabled = true;
      transferNote.textContent =
        "Chỉ tài khoản có vai trò owner của công ty mới chuyển được chủ sở hữu canvas — liên hệ owner nếu cần.";
    } else {
      transferNote.textContent =
        "Sau khi chuyển, quyền xem/sửa đi theo chủ mới (chủ mới, quản lý của họ và owner). Lịch sử phiên bản và tác giả giữ nguyên.";
      fillOwnerOptions();
    }
    // Archived: every op above is closed; only "Bỏ lưu trữ" stays live.
    archiveBtn.hidden = archived;
    unarchiveBtn.hidden = !archived;
    unarchiveBtn.disabled = !archived;
  }

  function fillOwnerOptions() {
    const candidates = activeUsers.filter((u) => u.id !== canvas.ownerUserId);
    ownerSel.replaceChildren(
      Object.assign(el("option"), {
        value: "",
        textContent: usersLoaded
          ? candidates.length
            ? "— chọn người nhận —"
            : "— không có người dùng hoạt động khác —"
          : "Đang tải danh sách…",
      }),
      ...candidates.map((u) =>
        Object.assign(el("option"), {
          value: u.id,
          textContent: `${u.name} — ${u.email}`,
        }),
      ),
    );
  }

  async function loadUsers() {
    if (!isOwnerRole) return;
    try {
      activeUsers = (await apiFetchAll("/users?limit=100")).filter(
        (u) => u.status === "active",
      );
    } catch {
      status.textContent =
        "Không tải được danh sách người dùng — tải lại trang để chuyển chủ sở hữu.";
    }
    usersLoaded = true;
    fillOwnerOptions();
  }

  async function failMessage(res, action) {
    if (res.status === 404) {
      return `Không ${action} được: bạn không có quyền với canvas này (hoặc canvas không còn tồn tại).`;
    }
    if (res.status === 403) {
      return `Không ${action} được: tài khoản của bạn không có quyền thực hiện thao tác này.`;
    }
    return `Không ${action} được: ${(await readFriendlyError(res)).message}`;
  }

  function adopt(dto) {
    canvas = dto;
    render();
    onChanged?.(dto);
  }

  renameBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "Tên canvas không được để trống.";
      nameInput.focus();
      return;
    }
    if (name === canvas.name) {
      status.textContent = "Tên không thay đổi.";
      return;
    }
    renameBtn.disabled = true;
    status.textContent = "Đang đổi tên…";
    try {
      const res = await apiFetch(`/canvases/${canvas.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        status.textContent = await failMessage(res, "đổi tên");
        return;
      }
      adopt(await res.json());
      status.textContent = "Đã đổi tên canvas.";
    } catch {
      status.textContent = "Mất kết nối máy chủ — thử lại sau.";
    } finally {
      renameBtn.disabled = canvas.status === "archived";
    }
  });

  transferBtn.addEventListener("click", async () => {
    const targetId = ownerSel.value;
    if (!targetId) {
      status.textContent = "Chọn người nhận trước khi chuyển.";
      return;
    }
    const target = activeUsers.find((u) => u.id === targetId);
    const targetName = target ? target.name : targetId.slice(0, 8);
    const ok = await confirmDialog({
      testid: "transfer-dialog",
      title: `Chuyển canvas cho ${targetName}?`,
      intro: `“${canvas.name}” sẽ thuộc về ${targetName} thay cho ${canvas.ownerName || "chủ hiện tại"}.`,
      lines: [
        `Quyền xem/sửa đi theo chủ mới: ${targetName}, người quản lý của ${targetName} và owner.`,
        "Chủ cũ và quản lý của chủ cũ có thể mất quyền mở canvas này ngay sau khi chuyển.",
        "Lịch sử phiên bản, tác giả từng phiên bản và bản nháp hiện tại được giữ nguyên.",
        "Thao tác được ghi audit.",
      ],
      confirmLabel: "Chuyển chủ sở hữu",
    });
    if (!ok) {
      status.textContent = "Đã hủy chuyển chủ sở hữu.";
      return;
    }
    transferBtn.disabled = true;
    status.textContent = "Đang chuyển chủ sở hữu…";
    try {
      const res = await apiFetch(`/canvases/${canvas.id}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerId: targetId }),
      });
      if (!res.ok) {
        status.textContent = await failMessage(res, "chuyển chủ sở hữu");
        return;
      }
      adopt(await res.json());
      status.textContent = `Đã chuyển chủ sở hữu cho ${targetName}.`;
    } catch {
      status.textContent = "Mất kết nối máy chủ — thử lại sau.";
    } finally {
      render();
    }
  });

  archiveBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      testid: "archive-dialog",
      title: "Lưu trữ canvas này?",
      intro: `“${canvas.name}” sẽ chuyển sang trạng thái lưu trữ.`,
      lines: [
        "Canvas chuyển sang CHỈ XEM: không sửa bản nháp, không chốt phiên bản, không chạy AI, không đổi tên hay chuyển chủ.",
        "Các phiên bản đã chốt và bản nháp hiện tại được giữ nguyên — vẫn xem và tải về được trong “Lịch sử”.",
        "Muốn mở lại: “⚙ Quản lý canvas” → “Bỏ lưu trữ”.",
      ],
      confirmLabel: "Lưu trữ canvas",
    });
    if (!ok) {
      status.textContent = "Đã hủy lưu trữ.";
      return;
    }
    archiveBtn.disabled = true;
    status.textContent = "Đang lưu các thay đổi chưa lưu…";
    try {
      if (beforeArchive && !(await beforeArchive())) {
        status.textContent =
          "Bản nháp chưa lưu được (lỗi hoặc xung đột) — xử lý trước rồi lưu trữ, để không mất phần đang sửa.";
        return;
      }
      status.textContent = "Đang lưu trữ…";
      const res = await apiFetch(`/canvases/${canvas.id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        status.textContent = await failMessage(res, "lưu trữ");
        return;
      }
      const dto = await res.json();
      adopt(dto);
      status.textContent = "Đã lưu trữ — canvas chuyển sang chỉ xem.";
      onArchived?.(dto);
    } catch {
      status.textContent = "Mất kết nối máy chủ — thử lại sau.";
    } finally {
      render();
    }
  });

  async function unarchive() {
    const ok = await confirmDialog({
      testid: "unarchive-dialog",
      title: "Bỏ lưu trữ canvas này?",
      intro: `“${canvas.name}” sẽ quay lại trạng thái đang hoạt động.`,
      lines: [
        "Canvas mở lại để sửa bản nháp, chốt phiên bản và chạy AI như trước.",
        "Bản nháp và các phiên bản đã chốt giữ nguyên; lần lưu trữ trước vẫn nằm trong nhật ký.",
      ],
      confirmLabel: "Bỏ lưu trữ",
    });
    if (!ok) {
      status.textContent = "Đã hủy bỏ lưu trữ.";
      return;
    }
    unarchiveBtn.disabled = true;
    status.textContent = "Đang bỏ lưu trữ…";
    try {
      const res = await apiFetch(`/canvases/${canvas.id}/unarchive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        status.textContent = await failMessage(res, "bỏ lưu trữ");
        return;
      }
      const dto = await res.json();
      adopt(dto);
      status.textContent = "Đã bỏ lưu trữ — đang mở lại trình sửa…";
      onUnarchived?.(dto);
    } catch {
      status.textContent = "Mất kết nối máy chủ — thử lại sau.";
    } finally {
      render();
    }
  }
  unarchiveBtn.addEventListener("click", unarchive);

  render();
  void loadUsers();

  return {
    toggle() {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.scrollIntoView({ behavior: "smooth" });
    },
    open() {
      panel.hidden = false;
      panel.scrollIntoView({ behavior: "smooth" });
    },
    current: () => canvas,
    unarchive,
  };
}
