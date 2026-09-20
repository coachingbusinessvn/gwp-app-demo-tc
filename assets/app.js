/* assets/app.js — account shell chung (task 0.5).
 *
 * Phase 0 chỉ ship account shell: định danh thật lấy từ GET /api/v1/auth/me
 * (qua apiFetch — Bearer trong memory, cookie refresh HttpOnly). Không còn
 * localStorage "gwp-demo-tc-session", không còn PEOPLE/ORG/canvas từ
 * assets/data.js — các mục nghiệp vụ demo hiển thị placeholder
 * "Chưa mở — Phase 2" cho tới khi canvas data thật được port.
 *
 * Loaded as <script type="module"> — no inline scripts (CSP script-src 'self').
 */
import { logout, requireAuth } from "../web/auth.js";

/* ---------- Helpers ---------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------- Header / footer ---------- */
const LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="none" stroke="#C9A668" stroke-width="3"/><path d="M20 22l7 22 5-14 5 14 7-22" fill="none" stroke="#E7D0A2" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

function renderHeader(me, roles) {
  // Admin entry point is a UX convenience only — roles come from
  // GET /auth/me (DB truth) and every admin API re-checks server-side.
  const adminNav =
    roles.includes("owner") || roles.includes("admin")
      ? '<a href="admin.html">Quản trị</a>'
      : "";
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<header class="app"><div class="bar">' +
      '<img class="mark" src="' + LOGO + '" alt="">' +
      '<div><div class="brand">GoWise Partners</div><div class="appname">Performance Follow-up</div></div>' +
      '<nav class="sitenav" aria-label="Công cụ">' +
      '<a href="dashboard.html">Bảng theo dõi</a>' +
      adminNav +
      "</nav>" +
      '<div class="spacer"></div>' +
      '<div class="who" data-testid="account-name"><b>' + esc(me.name) + "</b><br>" +
      esc(me.title || me.email) + "</div>" +
      '<a class="out" href="#" id="btnOut">Đăng xuất</a>' +
      "</div></header>",
  );
  document.getElementById("btnOut").addEventListener("click", async (e) => {
    e.preventDefault();
    await logout();
    location.replace("index.html");
  });
}

function renderFooter() {
  document.body.insertAdjacentHTML(
    "beforeend",
    '<footer class="app"><b>GoWise Partners</b> · Performance Architecture Canvas schema 3.0 — ' +
      "Phase 0: account shell. Nghiệp vụ canvas mở lại ở Phase 2.</footer>",
  );
}

/* ---------- Disabled business sections ---------- */
function lockedHTML(what) {
  return (
    '<div class="locked">' +
    '<span class="chip draft">Chưa mở — Phase 2</span>' +
    '<p class="note" style="margin-top:10px">' + esc(what) +
    " đang được chuyển sang dữ liệu thật và sẽ mở lại ở Phase 2.</p></div>"
  );
}

/* ---------- Page initializers ---------- */
async function init() {
  const identity = await requireAuth(); // { user, roles } — null after redirect
  if (!identity) return;
  const me = identity.user;
  renderHeader(me, identity.roles ?? []);

  const page = document.body.dataset.page;

  if (page === "dashboard") {
    const first = me.name.trim().split(/\s+/).slice(-1)[0];
    const ptitle = document.getElementById("ptitle");
    if (ptitle) ptitle.textContent = `Chào ${first}, đây là tình hình hôm nay`;
    const psub = document.getElementById("psub");
    if (psub) psub.textContent = me.title || me.email;

    const attention = document.getElementById("attention");
    if (attention) {
      attention.innerHTML =
        '<div class="eyebrow">Ưu tiên hôm nay</div><h2 class="title">Cần bạn xử lý</h2>' +
        lockedHTML("Theo dõi canvas đội ngũ");
    }
    const tree = document.getElementById("tree");
    if (tree) tree.innerHTML = lockedHTML("Sơ đồ đội ngũ");
    const mine = document.getElementById("mine");
    if (mine) {
      mine.innerHTML =
        '<h2 class="title">Canvas cá nhân</h2>' + lockedHTML("Canvas cá nhân");
    }

    // Tabs (layout giữ nguyên — nội dung là placeholder Phase 2).
    const tabs = [
      ["tab-team", "panel-team"],
      ["tab-mine", "panel-mine"],
    ];
    tabs.forEach(([tid, pid]) => {
      document.getElementById(tid)?.addEventListener("click", () => {
        tabs.forEach(([t, p]) => {
          const on = t === tid;
          document.getElementById(t)?.setAttribute("aria-selected", String(on));
          const panel = document.getElementById(p);
          if (panel) panel.hidden = !on;
        });
      });
    });
  }

  if (page === "employee") {
    const cname = document.getElementById("cname");
    if (cname) cname.textContent = "Canvas theo tuần";
    const head = document.getElementById("head");
    if (head) {
      head.innerHTML =
        '<div class="card"><h1 class="title">Canvas theo tuần</h1>' +
        lockedHTML("Hồ sơ canvas theo tuần của từng người") + "</div>";
    }
    const trend = document.getElementById("trend");
    if (trend) {
      trend.innerHTML =
        '<div class="eyebrow">Biến đổi hiệu suất</div><h2 class="title">Ba tầng bằng chứng theo tuần</h2>' +
        lockedHTML("Biểu đồ xu hướng");
    }
    const list = document.getElementById("list");
    if (list) {
      list.innerHTML =
        '<div class="eyebrow">Lịch sử</div><h2 class="title">Các bản canvas theo tuần</h2>' +
        lockedHTML("Lịch sử canvas");
    }
  }

  if (page === "canvas") {
    const cname = document.getElementById("vname");
    if (cname) cname.textContent = "Canvas chi tiết";
    const app = document.getElementById("app");
    if (app) {
      app.innerHTML =
        '<div class="card"><h1 class="title">Canvas chi tiết</h1>' +
        lockedHTML("Canvas chi tiết, gợi ý cải tiến và xuất tài liệu") +
        '<div class="btnrow" style="margin-top:12px"><a class="btn ghost" href="dashboard.html">Về bảng theo dõi</a></div></div>';
    }
  }

  renderFooter();
}

init();
