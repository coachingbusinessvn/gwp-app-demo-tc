/* web/admin/org.js — Tổ chức tab: departments, teams and the branding
 * form (task 1.5). All mutations go through reqJson/apiFetch; archive
 * failures surface the server's 409 ORG_UNIT_IN_USE guidance text
 * verbatim (chuyển thành viên trước khi lưu trữ). Rendering is DOM-only —
 * unit names reach the page via textContent, never markup.
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

function errBox() {
  const box = el("p", "err");
  box.setAttribute("role", "alert");
  box.style.color = "var(--risk)";
  box.style.fontSize = "12.5px";
  box.hidden = true;
  return box;
}

function archivedChip() {
  return el("span", "chip draft", "Đã lưu trữ");
}

function unitRow(name, archived, actions) {
  const li = el("li");
  li.style.margin = "8px 0";
  const row = el("div", "person");
  row.style.cursor = "default";
  row.append(el("span", "nm", name));
  if (archived) row.append(archivedChip());
  const meta = el("span", "meta");
  for (const a of actions) meta.append(a);
  row.append(meta);
  li.append(row);
  return li;
}

export function mountOrg(panel, ctx) {
  const { branding, onBrandingSaved } = ctx;
  const state = { departments: [], teams: [] };

  /* ---------- Departments ---------- */
  const depCard = el("section", "card");
  depCard.append(el("div", "eyebrow", "Cơ cấu"));
  depCard.append(el("h2", "title", "Phòng ban"));
  depCard.append(
    el(
      "p",
      "note",
      "Lưu trữ giữ lại mọi liên kết lịch sử — không xoá cứng. Đơn vị còn người hoặc còn tổ phải chuyển trước.",
    ),
  );
  const depErr = errBox();
  const depList = el("ul", "tree");
  depList.id = "dep-list";
  const depFormHost = el("div");
  const depAdd = miniButton("Tạo phòng ban");
  depAdd.classList.add("ghost");
  depCard.append(depErr, depList, depFormHost, depAdd);
  panel.append(depCard);

  function renderDepartments() {
    depList.replaceChildren();
    for (const d of state.departments) {
      const actions = [];
      if (d.archivedAt === null) {
        const rename = miniButton("Đổi tên");
        rename.addEventListener("click", () => openRenameDepartment(d));
        const archive = miniButton("Lưu trữ");
        archive.addEventListener("click", () => archiveDepartment(d));
        actions.push(rename, archive);
      }
      depList.append(unitRow(d.name, d.archivedAt !== null, actions));
    }
    if (state.departments.length === 0) {
      depList.append(el("li", "note", "Chưa có phòng ban nào."));
    }
  }

  function closeDepForm() {
    depFormHost.replaceChildren();
    depAdd.hidden = false;
  }

  function openRenameDepartment(d) {
    depFormHost.replaceChildren();
    depAdd.hidden = true;
    clearError(depErr);
    const input = textInput({ value: d.name, maxlength: "200", required: "" });
    input.value = d.name;
    const form = el("form");
    form.style.margin = "10px 0";
    form.append(field("Tên mới", input));
    const save = submitButton("Lưu");
    const cancel = miniButton("Huỷ");
    const btns = el("div", "btnrow");
    btns.style.marginTop = "10px";
    btns.append(save, cancel);
    form.append(btns);
    cancel.addEventListener("click", closeDepForm);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError(depErr);
      try {
        await reqJson("PATCH", `/departments/${d.id}`, {
          name: input.value,
        });
        closeDepForm();
        await loadOrg();
      } catch (err) {
        showError(depErr, err);
      }
    });
    depFormHost.append(form);
    input.focus();
  }

  async function archiveDepartment(d) {
    clearError(depErr);
    try {
      await reqJson("POST", `/departments/${d.id}/archive`);
      await loadOrg();
    } catch (err) {
      // 409 ORG_UNIT_IN_USE — the server message already carries the
      // guidance ("chuyển thành viên / lưu trữ tổ trước"); show it verbatim.
      showError(depErr, err);
    }
  }

  depAdd.addEventListener("click", () => {
    depFormHost.replaceChildren();
    depAdd.hidden = true;
    clearError(depErr);
    const input = textInput({ maxlength: "200", required: "" });
    const form = el("form");
    form.style.margin = "10px 0";
    form.append(field("Tên phòng ban", input));
    const btns = el("div", "btnrow");
    btns.style.marginTop = "10px";
    btns.append(submitButton("Lưu"), (() => {
      const c = miniButton("Huỷ");
      c.addEventListener("click", closeDepForm);
      return c;
    })());
    form.append(btns);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError(depErr);
      try {
        await reqJson("POST", "/departments", { name: input.value });
        closeDepForm();
        await loadOrg();
      } catch (err) {
        showError(depErr, err);
      }
    });
    depFormHost.append(form);
    input.focus();
  });

  /* ---------- Teams ---------- */
  const teamCard = el("section", "card");
  teamCard.append(el("h2", "title", "Tổ"));
  const teamErr = errBox();
  const teamList = el("ul", "tree");
  const teamFormHost = el("div");
  const teamAdd = miniButton("Tạo tổ");
  teamCard.append(teamErr, teamList, teamFormHost, teamAdd);
  panel.append(teamCard);

  function departmentName(id) {
    const d = state.departments.find((x) => x.id === id);
    return d ? d.name : "—";
  }

  function renderTeams() {
    teamList.replaceChildren();
    for (const t of state.teams) {
      const actions = [];
      if (t.archivedAt === null) {
        const archive = miniButton("Lưu trữ");
        archive.addEventListener("click", () => archiveTeam(t));
        actions.push(archive);
      }
      const li = el("li");
      li.style.margin = "8px 0";
      const row = el("div", "person");
      row.style.cursor = "default";
      const label = el("span");
      label.append(el("span", "nm", t.name));
      label.append(el("span", "rl", ` — ${departmentName(t.departmentId)}`));
      row.append(label);
      if (t.archivedAt !== null) row.append(archivedChip());
      if (actions.length > 0) {
        const meta = el("span", "meta");
        for (const a of actions) meta.append(a);
        row.append(meta);
      }
      li.append(row);
      teamList.append(li);
    }
    if (state.teams.length === 0) {
      teamList.append(el("li", "note", "Chưa có tổ nào."));
    }
  }

  async function archiveTeam(t) {
    clearError(teamErr);
    try {
      await reqJson("POST", `/teams/${t.id}/archive`);
      await loadOrg();
    } catch (err) {
      showError(teamErr, err); // 409 ORG_UNIT_IN_USE guidance from server
    }
  }

  teamAdd.addEventListener("click", () => {
    teamFormHost.replaceChildren();
    teamAdd.hidden = true;
    clearError(teamErr);
    const name = textInput({ maxlength: "200", required: "" });
    const dep = selectInput();
    for (const d of state.departments.filter((x) => x.archivedAt === null)) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.name;
      dep.append(opt);
    }
    const form = el("form");
    form.style.margin = "10px 0";
    form.append(field("Tên tổ", name), field("Thuộc phòng ban", dep));
    const btns = el("div", "btnrow");
    btns.style.marginTop = "10px";
    const cancel = miniButton("Huỷ");
    cancel.addEventListener("click", () => {
      teamFormHost.replaceChildren();
      teamAdd.hidden = false;
    });
    btns.append(submitButton("Lưu"), cancel);
    form.append(btns);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError(teamErr);
      try {
        await reqJson("POST", "/teams", {
          name: name.value,
          departmentId: dep.value,
        });
        teamFormHost.replaceChildren();
        teamAdd.hidden = false;
        await loadOrg();
      } catch (err) {
        showError(teamErr, err);
      }
    });
    teamFormHost.append(form);
    name.focus();
  });

  /* ---------- Branding (nhận diện) ---------- */
  const brandCard = el("section", "card");
  brandCard.append(el("div", "eyebrow", "Nhận diện"));
  brandCard.append(el("h2", "title", "Thương hiệu hiển thị"));
  brandCard.append(
    el(
      "p",
      "note",
      "Tên hiển thị là văn bản thuần (không HTML/liên kết); màu nhấn là mã #rrggbb. Áp dụng cho toàn bộ shell sau khi lưu.",
    ),
  );
  const brandErr = errBox();
  const brandForm = el("form");
  const nameInput = textInput({
    maxlength: "120",
    required: "",
    value: branding?.displayName ?? "",
  });
  nameInput.value = branding?.displayName ?? "";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = branding?.accentColor ?? "#C9A668";
  colorInput.style.width = "64px";
  colorInput.style.height = "36px";
  colorInput.style.padding = "2px";
  colorInput.style.border = "1px solid var(--line)";
  colorInput.style.borderRadius = "var(--gp-radius-sm)";
  const swatch = el("span");
  swatch.id = "brand-accent";
  swatch.setAttribute("data-testid", "brand-accent");
  swatch.style.display = "inline-block";
  swatch.style.width = "22px";
  swatch.style.height = "22px";
  swatch.style.borderRadius = "4px";
  swatch.style.border = "1px solid var(--line)";
  swatch.style.verticalAlign = "middle";
  swatch.style.marginLeft = "10px";
  if (branding?.accentColor) swatch.style.backgroundColor = branding.accentColor;
  const colorRow = el("div");
  colorRow.style.display = "flex";
  colorRow.style.alignItems = "center";
  colorRow.append(colorInput, swatch);
  brandForm.append(
    field("Tên hiển thị", nameInput),
    field("Màu nhấn", colorRow),
  );
  const brandBtns = el("div", "btnrow");
  brandBtns.style.marginTop = "12px";
  brandBtns.append(submitButton("Lưu nhận diện"));
  brandForm.append(brandBtns);
  brandForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError(brandErr);
    try {
      const saved = await reqJson("PATCH", "/settings/branding", {
        displayName: nameInput.value,
        accentColor: colorInput.value, // type=color always yields #rrggbb
      });
      swatch.style.backgroundColor = saved.accentColor;
      onBrandingSaved?.(saved);
    } catch (err) {
      showError(brandErr, err);
    }
  });
  brandCard.append(brandErr, brandForm);
  panel.append(brandCard);

  /* ---------- Data ---------- */
  async function loadOrg() {
    const [deps, teams] = await Promise.all([
      reqJson("GET", "/departments?limit=100"),
      reqJson("GET", "/teams?limit=100"),
    ]);
    state.departments = deps.items;
    state.teams = teams.items;
    renderDepartments();
    renderTeams();
  }

  loadOrg().catch((err) => showError(depErr, err));
}
