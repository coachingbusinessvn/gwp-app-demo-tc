/* web/admin/org.js — Tổ chức tab: departments, teams and the branding
 * form (task 1.5). All mutations go through reqJson/apiFetch; archive
 * failures surface the server's 409 ORG_UNIT_IN_USE guidance text
 * verbatim (chuyển thành viên trước khi lưu trữ). Rendering is DOM-only —
 * unit names reach the page via textContent, never markup.
 *
 * Also hosts the company profile (GET/PATCH /company — name, IANA
 * timezone; owner/admin) and the retention floors (GET owner/admin, PATCH
 * owner only — spec §9: the owner may only RAISE the floors; the server
 * schema is the authority and its errors are shown per field).
 */
import {
  clearError,
  el,
  field,
  miniButton,
  reqAll,
  reqJson,
  selectInput,
  showError,
  showStatus,
  statusLine,
  submitButton,
  textInput,
} from "./http.js";

/**
 * Spec §9 minimums — mirrored for display only (server/src/modules/
 * settings/service.ts RETENTION_FLOORS is the authority; a lower value is
 * rejected there with 400 INVALID_INPUT).
 */
const RETENTION_FIELDS = [
  { key: "auditDays", label: "Nhật ký audit", floor: 365 },
  { key: "aiRunDays", label: "Metadata lượt chạy AI", floor: 90 },
  { key: "logDays", label: "Log vận hành", floor: 30 },
  { key: "receiptDays", label: "Biên nhận ghi (chống gửi trùng)", floor: 7 },
];

/** IANA zones from the runtime's ICU; the current value is always kept. */
function timezoneOptions(current) {
  let zones = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const set = new Set(zones);
  for (const z of ["Asia/Ho_Chi_Minh", "UTC", current]) {
    if (z) set.add(z);
  }
  return [...set].sort();
}

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
  const { branding, onBrandingSaved, isOwner = false } = ctx;
  const state = { departments: [], teams: [] };

  /* ---------- Company profile ---------- */
  const companyCard = el("section", "card");
  companyCard.append(el("div", "eyebrow", "Công ty"));
  companyCard.append(el("h2", "title", "Thông tin công ty"));
  companyCard.append(
    el(
      "p",
      "note",
      "Tên pháp nhân và múi giờ dùng cho mốc thời gian của tổ chức. Tên hiển thị trên giao diện chỉnh ở mục Nhận diện.",
    ),
  );
  const companyErr = errBox();
  const companyStatus = statusLine();
  const companyForm = el("form");
  const companyName = textInput({ maxlength: "200", required: "" });
  const companyTz = selectInput();
  companyForm.append(
    field("Tên công ty", companyName),
    field("Múi giờ", companyTz),
  );
  const companyBtns = el("div", "btnrow");
  companyBtns.style.marginTop = "12px";
  companyBtns.append(submitButton("Lưu thông tin công ty"));
  companyForm.append(companyBtns);
  companyForm.hidden = true; // until GET /company answers
  companyCard.append(companyErr, companyStatus, companyForm);
  panel.append(companyCard);

  function fillCompany(company) {
    companyName.value = company.name;
    companyTz.replaceChildren();
    for (const z of timezoneOptions(company.timezone)) {
      const opt = document.createElement("option");
      opt.value = z;
      opt.textContent = z;
      if (z === company.timezone) opt.selected = true;
      companyTz.append(opt);
    }
    companyForm.hidden = false;
  }

  companyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError(companyErr);
    clearError(companyStatus);
    try {
      const saved = await reqJson("PATCH", "/company", {
        name: companyName.value,
        timezone: companyTz.value,
      });
      fillCompany(saved);
      showStatus(companyStatus, "Đã lưu thông tin công ty.");
    } catch (err) {
      showError(companyErr, err);
    }
  });

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
        rename.setAttribute("aria-label", `Đổi tên phòng ban ${d.name}`);
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
        const rename = miniButton("Đổi tên");
        rename.setAttribute("aria-label", `Đổi tên tổ ${t.name}`);
        rename.addEventListener("click", () => openRenameTeam(t));
        const archive = miniButton("Lưu trữ");
        archive.addEventListener("click", () => archiveTeam(t));
        actions.push(rename, archive);
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

  function closeTeamForm() {
    teamFormHost.replaceChildren();
    teamAdd.hidden = false;
  }

  function openRenameTeam(t) {
    teamFormHost.replaceChildren();
    teamAdd.hidden = true;
    clearError(teamErr);
    const input = textInput({ maxlength: "200", required: "" });
    input.value = t.name;
    const form = el("form");
    form.style.margin = "10px 0";
    form.append(field("Tên tổ mới", input));
    const btns = el("div", "btnrow");
    btns.style.marginTop = "10px";
    const cancel = miniButton("Huỷ");
    cancel.addEventListener("click", closeTeamForm);
    btns.append(submitButton("Lưu"), cancel);
    form.append(btns);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError(teamErr);
      try {
        await reqJson("PATCH", `/teams/${t.id}`, { name: input.value });
        closeTeamForm();
        await loadOrg();
      } catch (err) {
        showError(teamErr, err);
      }
    });
    teamFormHost.append(form);
    input.focus();
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

  /* ---------- Retention (spec §9) ---------- */
  const retCard = el("section", "card");
  retCard.append(el("div", "eyebrow", "Dữ liệu"));
  retCard.append(el("h2", "title", "Thời gian lưu giữ"));
  retCard.append(
    el(
      "p",
      "note",
      isOwner
        ? "Số ngày giữ dữ liệu trước khi job dọn dẹp xoá. Chỉ được tăng so với mức tối thiểu của hệ thống, không được giảm. Bản sao lưu có thể còn dữ liệu đã xoá tới hết thời hạn của nó."
        : "Số ngày giữ dữ liệu trước khi job dọn dẹp xoá. Chỉ owner được thay đổi — admin chỉ xem.",
    ),
  );
  const retErr = errBox();
  const retStatus = statusLine();
  const retForm = el("form");
  // The server schema is the authority on the floors: no native min=
  // blocking, so a below-floor value reaches it and its 400 is shown.
  retForm.noValidate = true;
  retForm.hidden = true; // until GET /settings/retention answers
  const retInputs = new Map();
  for (const f of RETENTION_FIELDS) {
    const input = textInput({ inputmode: "numeric" });
    input.type = "number";
    input.step = "1";
    input.style.maxWidth = "180px";
    input.disabled = !isOwner;
    retInputs.set(f.key, input);
    const wrap = field(`${f.label} (ngày)`, input);
    wrap.append(el("p", "note", `Tối thiểu ${f.floor} ngày.`));
    retForm.append(wrap);
  }
  if (isOwner) {
    const retBtns = el("div", "btnrow");
    retBtns.style.marginTop = "12px";
    retBtns.append(submitButton("Lưu thời gian lưu giữ"));
    retForm.append(retBtns);
  }
  retCard.append(retErr, retStatus, retForm);
  panel.append(retCard);

  function fillRetention(values) {
    for (const f of RETENTION_FIELDS) {
      retInputs.get(f.key).value = String(values[f.key] ?? f.floor);
    }
    retForm.hidden = false;
  }

  retForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isOwner) return;
    clearError(retErr);
    clearError(retStatus);
    const body = {};
    for (const f of RETENTION_FIELDS) {
      const raw = retInputs.get(f.key).value.trim();
      // Send what was typed; a non-number goes as-is so the server's
      // INVALID_INPUT names the field instead of a silent coercion.
      body[f.key] = raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    }
    try {
      const saved = await reqJson("PATCH", "/settings/retention", body);
      fillRetention(saved);
      showStatus(retStatus, "Đã lưu thời gian lưu giữ.");
    } catch (err) {
      const bad = RETENTION_FIELDS.filter((f) =>
        (err.fields ?? []).includes(f.key),
      );
      if (err.code === "INVALID_INPUT" && bad.length > 0) {
        showError(
          retErr,
          `${err.message}: ` +
            bad
              .map((f) => `${f.label} phải là số nguyên ≥ ${f.floor} ngày`)
              .join("; ") +
            ".",
        );
      } else {
        showError(retErr, err);
      }
    }
  });

  /* ---------- Data ---------- */
  async function loadOrg() {
    // Walk every cursor page — the server caps one page at 100.
    const [deps, teams] = await Promise.all([
      reqAll("/departments?limit=100"),
      reqAll("/teams?limit=100"),
    ]);
    state.departments = deps;
    state.teams = teams;
    renderDepartments();
    renderTeams();
  }

  loadOrg().catch((err) => showError(depErr, err));
  reqJson("GET", "/company")
    .then(fillCompany)
    .catch((err) => showError(companyErr, err));
  reqJson("GET", "/settings/retention")
    .then(fillRetention)
    .catch((err) => showError(retErr, err));
}
