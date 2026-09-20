/* web/admin/users.js — Người dùng tab (task 1.5, spec §4/§8).
 *
 * Owner-only controls — "Cấp quyền owner", the full role editor, "Đổi
 * cấp trên" and the credential-token issuers — are NOT RENDERED for admin
 * (not merely disabled); the API remains the authority either way.
 * Profile, reporting and role writes are separate forms hitting their own
 * endpoints, so a generic PATCH can never smuggle privilege fields.
 * Issued tokens are shown exactly once inside the page — never stored,
 * never logged.
 */
import {
  clearError,
  el,
  field,
  miniButton,
  reqJson,
  selectInput,
  showError,
  submitButton,
  textInput,
} from "./http.js";

const ALL_ROLES = ["owner", "admin", "manager", "member"];
const STATUS_LABEL = {
  pending: "Chờ kích hoạt",
  active: "Hoạt động",
  inactive: "Ngừng",
};
const STATUS_CHIP = { pending: "draft", active: "validated", inactive: "risk" };

function errBox() {
  const box = el("p", "err");
  box.setAttribute("role", "alert");
  box.style.color = "var(--risk)";
  box.style.fontSize = "12.5px";
  box.hidden = true;
  return box;
}

function isPrivileged(user) {
  return user.roles.includes("owner") || user.roles.includes("admin");
}

export function mountUsers(panel, ctx) {
  const { isOwner, selfId } = ctx;
  const state = { users: [], departments: [], teams: [] };

  const card = el("section", "card");
  card.append(el("div", "eyebrow", "Tài khoản"));
  card.append(el("h2", "title", "Người dùng"));
  card.append(
    el(
      "p",
      "note",
      "Tạo tài khoản ở trạng thái chờ — owner phát mã kích hoạt một lần để người dùng tự đặt mật khẩu. Vai trò, cấp trên và mã xác thực chỉ dành cho owner.",
    ),
  );
  const err = errBox();
  const addBtn = miniButton("Tạo người dùng");
  const formHost = el("div");
  const tableWrap = el("div", "tscroll");
  const table = el("table", "t");
  const thead = el("thead");
  const headRow = el("tr");
  for (const h of ["Tên", "Email", "Chức danh", "Trạng thái", "Vai trò", "Thao tác"]) {
    headRow.append(el("th", null, h));
  }
  thead.append(headRow);
  const tbody = el("tbody");
  table.append(thead, tbody);
  tableWrap.append(table);
  card.append(err, formHost, addBtn, tableWrap);
  panel.append(card);

  function liveDepartments() {
    return state.departments.filter((d) => d.archivedAt === null);
  }
  function liveTeams(departmentId) {
    return state.teams.filter(
      (t) => t.archivedAt === null && t.departmentId === departmentId,
    );
  }

  function departmentSelect(selectedId) {
    const sel = selectInput();
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— Không có —";
    sel.append(none);
    for (const d of liveDepartments()) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.name;
      if (d.id === selectedId) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  }

  /** Repopulate a team <select>'s options (keeps the element + label). */
  function fillTeams(sel, departmentId, selectedId) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— Không có —";
    sel.append(none);
    for (const t of liveTeams(departmentId)) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === selectedId) opt.selected = true;
      sel.append(opt);
    }
  }

  function teamSelect(departmentId, selectedId) {
    const sel = selectInput();
    fillTeams(sel, departmentId, selectedId);
    return sel;
  }

  /** Department+team field pair — the team list follows the department. */
  function orgFields(current) {
    const dep = departmentSelect(current?.departmentId ?? null);
    const teamSel = teamSelect(dep.value || null, current?.teamId ?? null);
    const teamField = field("Tổ", teamSel);
    dep.addEventListener("change", () => {
      // Swap only the <option>s — replacing the element would orphan the
      // label's for/id association that field() wired up.
      teamSel.replaceChildren();
      fillTeams(teamSel, dep.value || null, null);
    });
    return {
      nodes: [field("Phòng ban", dep), teamField],
      values: () => ({
        departmentId: dep.value === "" ? null : dep.value,
        teamId: teamSel.value === "" ? null : teamSel.value,
      }),
    };
  }

  /* ---------- Row expanders ---------- */
  function expander(row, build) {
    const existing = row.nextElementSibling;
    if (existing?.classList.contains("expander")) {
      existing.remove();
      return;
    }
    tbody
      .querySelectorAll("tr.expander")
      .forEach((n) => n.remove());
    const tr = el("tr", "expander");
    const td = el("td");
    td.colSpan = 6;
    tr.append(td);
    row.after(tr);
    build(td, () => tr.remove());
  }

  function closeBtn(close) {
    const c = miniButton("Đóng");
    c.addEventListener("click", close);
    return c;
  }

  /* ---------- Forms ---------- */
  function openCreateForm() {
    formHost.replaceChildren();
    addBtn.hidden = true;
    clearError(err);
    const email = textInput({ type: "email", required: "", maxlength: "320" });
    email.type = "email";
    const name = textInput({ required: "", maxlength: "200" });
    const title = textInput({ maxlength: "200" });
    const org = orgFields(null);
    const form = el("form");
    form.style.margin = "10px 0 16px";
    form.append(
      field("Email", email),
      field("Họ tên", name),
      field("Chức danh", title),
      ...org.nodes,
    );
    const btns = el("div", "btnrow");
    btns.style.marginTop = "10px";
    const cancel = miniButton("Huỷ");
    cancel.addEventListener("click", () => {
      formHost.replaceChildren();
      addBtn.hidden = false;
    });
    btns.append(submitButton("Lưu"), cancel);
    form.append(btns);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError(err);
      const body = { email: email.value, name: name.value };
      if (title.value.trim() !== "") body.title = title.value;
      const o = org.values();
      if (o.departmentId !== null) body.departmentId = o.departmentId;
      if (o.teamId !== null) body.teamId = o.teamId;
      try {
        await reqJson("POST", "/users", body);
        formHost.replaceChildren();
        addBtn.hidden = false;
        await loadUsers();
      } catch (e) {
        showError(err, e);
      }
    });
    formHost.append(form);
    email.focus();
  }

  function openEditForm(user, row) {
    expander(row, (td, close) => {
      // Admin editing a privileged profile is denied server-side; admin's
      // own row only exposes name/title (org placement is owner-only there).
      const canEditOrg = isOwner || !isPrivileged(user);
      const name = textInput({ required: "", maxlength: "200" });
      name.value = user.name;
      const title = textInput({ maxlength: "200" });
      title.value = user.title ?? "";
      const org = canEditOrg ? orgFields(user) : null;
      const form = el("form");
      form.append(field("Tên", name), field("Chức danh", title));
      if (org) form.append(...org.nodes);
      const btns = el("div", "btnrow");
      btns.style.marginTop = "10px";
      btns.append(submitButton("Lưu"), closeBtn(close));
      form.append(btns);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearError(err);
        const body = {
          name: name.value,
          title: title.value.trim() === "" ? null : title.value,
        };
        if (org) Object.assign(body, org.values());
        try {
          await reqJson("PATCH", `/users/${user.id}`, body);
          close();
          await loadUsers();
        } catch (e) {
          showError(err, e);
        }
      });
      td.append(form);
    });
  }

  function openRolesForm(user, row) {
    expander(row, (td, close) => {
      const form = el("form");
      form.append(el("h3", "sub", "Vai trò"));
      const boxes = new Map();
      const wrap = el("div");
      wrap.style.display = "flex";
      wrap.style.gap = "14px";
      wrap.style.flexWrap = "wrap";
      for (const role of ALL_ROLES) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = user.roles.includes(role);
        boxes.set(role, cb);
        const lab = el("label");
        lab.style.fontSize = "12.5px";
        lab.style.display = "inline-flex";
        lab.style.gap = "5px";
        lab.style.alignItems = "center";
        lab.append(cb, document.createTextNode(role));
        wrap.append(lab);
      }
      form.append(wrap);
      const btns = el("div", "btnrow");
      btns.style.marginTop = "10px";
      btns.append(submitButton("Lưu vai trò"), closeBtn(close));
      form.append(btns);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearError(err);
        const roles = ALL_ROLES.filter((r) => boxes.get(r).checked);
        try {
          await reqJson("PUT", `/users/${user.id}/roles`, { roles });
          close();
          await loadUsers();
        } catch (e) {
          showError(err, e);
        }
      });
      td.append(form);
    });
  }

  function openManagerForm(user, row) {
    expander(row, (td, close) => {
      const sel = selectInput();
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "— Không có cấp trên —";
      sel.append(none);
      for (const u of state.users) {
        if (u.id === user.id || u.status !== "active") continue;
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = `${u.name} (${u.email})`;
        if (u.id === user.managerId) opt.selected = true;
        sel.append(opt);
      }
      const form = el("form");
      form.append(field("Cấp trên trực tiếp", sel));
      const btns = el("div", "btnrow");
      btns.style.marginTop = "10px";
      btns.append(submitButton("Lưu cấp trên"), closeBtn(close));
      form.append(btns);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearError(err);
        try {
          await reqJson("PUT", `/users/${user.id}/manager`, {
            managerId: sel.value === "" ? null : sel.value,
          });
          close();
          await loadUsers();
        } catch (e) {
          showError(err, e);
        }
      });
      td.append(form);
    });
  }

  function openReportsDecision(user, row) {
    expander(row, (td, close) => {
      td.append(
        el(
          "p",
          "note",
          "Người này còn cấp dưới — chọn cấp trên thay thế cho các cấp dưới, hoặc bỏ gán.",
        ),
      );
      const sel = selectInput();
      const unassign = document.createElement("option");
      unassign.value = "";
      unassign.textContent = "— Bỏ gán cấp dưới —";
      sel.append(unassign);
      for (const u of state.users) {
        if (u.id === user.id || u.status !== "active") continue;
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = `${u.name} (${u.email})`;
        sel.append(opt);
      }
      const form = el("form");
      form.append(field("Cấp trên thay thế", sel));
      const btns = el("div", "btnrow");
      btns.style.marginTop = "10px";
      const confirm = submitButton("Xác nhận ngừng hoạt động");
      btns.append(confirm, closeBtn(close));
      form.append(btns);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        clearError(err);
        try {
          await reqJson("POST", `/users/${user.id}/deactivate`, {
            replacementManagerId: sel.value === "" ? null : sel.value,
          });
          close();
          await loadUsers();
        } catch (e) {
          showError(err, e);
        }
      });
      td.append(form);
    });
  }

  function showIssuedToken(user, row, purpose, issued) {
    expander(row, (td) => {
      td.append(
        el(
          "p",
          "note",
          "Mã chỉ hiển thị một lần — gửi liên kết này cho người dùng qua kênh nội bộ. Hết hạn: " +
            new Date(issued.expiresAt).toLocaleString("vi-VN"),
        ),
      );
      const link = `${location.origin}/activate.html?token=${encodeURIComponent(
        issued.token,
      )}${purpose === "reset" ? "&purpose=reset" : ""}`;
      const input = textInput({ readonly: "" });
      input.value = link;
      input.style.fontSize = "12px";
      td.append(input);
    });
  }

  async function issueToken(user, row, purpose) {
    clearError(err);
    try {
      const issued = await reqJson(
        "POST",
        `/users/${user.id}/credential-token`,
        { purpose },
      );
      showIssuedToken(user, row, purpose, issued);
    } catch (e) {
      showError(err, e);
    }
  }

  async function deactivate(user, row) {
    clearError(err);
    try {
      await reqJson("POST", `/users/${user.id}/deactivate`, {});
      await loadUsers();
    } catch (e) {
      if (e && e.code === "REPORTS_UNASSIGNED") {
        // The target still has direct reports — the owner must decide the
        // reports' line in the same call (transfer or unassign).
        openReportsDecision(user, row);
      } else {
        showError(err, e);
      }
    }
  }

  /* ---------- List ---------- */
  function renderUsers() {
    tbody.replaceChildren();
    for (const u of state.users) {
      const tr = el("tr");
      tr.append(el("td", null, u.name));
      tr.append(el("td", null, u.email));
      tr.append(el("td", null, u.title ?? "—"));
      const statusTd = el("td");
      statusTd.append(
        el("span", `chip ${STATUS_CHIP[u.status] ?? "draft"}`,
          STATUS_LABEL[u.status] ?? u.status),
      );
      tr.append(statusTd);
      tr.append(el("td", null, u.roles.join(", ") || "—"));
      const actions = el("td");
      actions.style.whiteSpace = "nowrap";
      const add = (btn) => {
        btn.style.margin = "0 4px 4px 0";
        actions.append(btn);
      };
      // Profile edit: admin may not touch privileged profiles; admin's own
      // row only edits name/title (enforced in the form + by the server).
      if (isOwner || !isPrivileged(u) || u.id === selfId) {
        const edit = miniButton("Sửa hồ sơ");
        edit.addEventListener("click", () => openEditForm(u, tr));
        add(edit);
      }
      if (isOwner) {
        if (!u.roles.includes("owner")) {
          const grant = miniButton("Cấp quyền owner");
          grant.addEventListener("click", async () => {
            clearError(err);
            try {
              await reqJson("PUT", `/users/${u.id}/roles`, {
                roles: [...u.roles, "owner"],
              });
              await loadUsers();
            } catch (e) {
              showError(err, e);
            }
          });
          add(grant);
        }
        const rolesBtn = miniButton("Vai trò");
        rolesBtn.addEventListener("click", () => openRolesForm(u, tr));
        add(rolesBtn);
        const mgr = miniButton("Đổi cấp trên");
        mgr.addEventListener("click", () => openManagerForm(u, tr));
        add(mgr);
        if (u.id !== selfId && u.status === "pending") {
          const act = miniButton("Phát mã kích hoạt");
          act.addEventListener("click", () => issueToken(u, tr, "activate"));
          add(act);
        }
        if (u.id !== selfId && u.status === "active") {
          const reset = miniButton("Phát mã reset");
          reset.addEventListener("click", () => issueToken(u, tr, "reset"));
          add(reset);
        }
      }
      if (
        u.status !== "inactive" &&
        u.id !== selfId &&
        (isOwner || !isPrivileged(u))
      ) {
        const off = miniButton("Ngừng hoạt động");
        off.addEventListener("click", () => deactivate(u, tr));
        add(off);
      }
      tr.append(actions);
      tbody.append(tr);
    }
  }

  async function loadUsers() {
    const [users, deps, teams] = await Promise.all([
      reqJson("GET", "/users?limit=100"),
      reqJson("GET", "/departments?limit=100"),
      reqJson("GET", "/teams?limit=100"),
    ]);
    state.users = users.items;
    state.departments = deps.items;
    state.teams = teams.items;
    renderUsers();
  }

  addBtn.addEventListener("click", openCreateForm);
  loadUsers().catch((e) => showError(err, e));
}
