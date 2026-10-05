/* assets/app.js — account shell chung + bảng theo dõi (tasks 0.5, 2.6).
 *
 * Định danh thật lấy từ GET /api/v1/auth/me (qua apiFetch — Bearer trong
 * memory, cookie refresh HttpOnly). Dashboard + employee đọc dữ liệu thật
 * từ GET /api/v1/dashboard — phạm vi subject do policy phía server quyết,
 * xu hướng chỉ vẽ từ measurement trên bản đã chốt (không vẽ số bịa).
 *
 * Loaded as <script type="module"> — no inline scripts (CSP script-src 'self').
 */
import { requireAuth } from "../web/auth.js";
import { apiFetch } from "../web/api.js";
import {
  applyBranding,
  loadBranding,
  renderAppFooter,
  renderAppHeader,
} from "../web/shell.js";

/* ---------- Helpers ---------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function initials(name) {
  const p = String(name || "?").trim().split(/\s+/);
  return (p[0][0] + (p[p.length - 1][0] || "")).toUpperCase();
}
function dmy(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? esc(iso)
    : d.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}
/* A failed read carries its HTTP status (0 = network) so callers can tell
 * "could not load" apart from a legitimate empty / out-of-scope answer. */
class LoadError extends Error {
  constructor(status) {
    super(`dashboard ${status}`);
    this.status = status;
  }
}
async function fetchDashboard() {
  let res;
  try {
    res = await apiFetch("/dashboard");
  } catch {
    throw new LoadError(0);
  }
  if (res.status === 401) {
    // Session ended mid-page (apiFetch already tried one refresh).
    location.replace("/index.html");
    throw new LoadError(401);
  }
  if (!res.ok) throw new LoadError(res.status);
  return res.json();
}

/* ---------- Header / footer ---------- */
/* Chrome comes from the shared shell (web/shell.js): nav with Canvas Online
 * + Coaching Report (+ Quản trị for owner/admin), account name → account.html,
 * logout, company branding. Same module the hero-header pages self-mount. */

/* ---------- Loading / error states ---------- */
// Sections render a visible "Đang tải…" until their fetch settles, so a
// slow network never reads as "empty" (aria-busy for assistive tech).
function setLoading(node, eyebrow, title) {
  if (!node) return;
  node.setAttribute("aria-busy", "true");
  node.innerHTML =
    (eyebrow ? '<div class="eyebrow">' + esc(eyebrow) + "</div>" : "") +
    (title ? '<h2 class="title">' + esc(title) + "</h2>" : "") +
    '<p class="loading" role="status">Đang tải…</p>';
}
function setLoaded(node, html) {
  if (!node) return;
  node.removeAttribute("aria-busy");
  node.innerHTML = html;
}
const RETRY_HTML =
  '<div class="btnrow" style="margin-top:10px"><button class="btn ghost" type="button" data-retry>Thử lại</button></div>';
// Retry = full reload: the dashboard read is one request, and a reload
// also re-runs the session gate if the failure was an expired session.
document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("[data-retry]")) {
    location.reload();
  }
});

/* ---------- Dashboard data renderers ---------- */
const STATUS_CHIP = {
  unpublished: '<span class="chip draft">Chưa chốt</span>',
  published: '<span class="chip piloting">Đã chốt</span>',
  archived: '<span class="chip draft">Lưu trữ</span>',
};
const STAGE_CHIP = {
  DRAFT: '<span class="chip draft">Draft</span>',
  PILOTING: '<span class="chip piloting">Piloting</span>',
  VALIDATED: '<span class="chip validated">Validated</span>',
};

function attentionHTML(items) {
  const rows = items
    .map(
      (x) =>
        '<div class="rec risk"><div class="ic">⚠</div><div class="tx">' +
        "<b>" + esc(x.action) + "</b>" +
        "<span>" +
        '<a class="wlink" href="canvas.html?canvas=' + encodeURIComponent(x.canvasId) + '">' +
        esc(x.canvasName) + "</a>" +
        " · hạn " + esc(dmy(x.deadline)) +
        " · quá " + x.daysOverdue + " ngày</span>" +
        "</div></div>",
    )
    .join("");
  return (
    '<div class="eyebrow">Ưu tiên hôm nay</div><h2 class="title">Cần bạn xử lý</h2>' +
    (rows
      ? '<div class="recs">' + rows + "</div>"
      : '<div class="recs"><div class="rec ok"><div class="ic">✓</div>' +
        '<div class="tx"><b>Không có việc quá hạn</b>' +
        "<span>Mọi hành động giao cho bạn trên các canvas bạn đọc được đều còn trong hạn.</span>" +
        "</div></div></div>")
  );
}

/* Cây đội ngũ: chỉ các subject trong phạm vi — gốc là chính mình, các nút
 * mồ côi (manager ngoài phạm vi) treo vào gốc để không mất người. */
function treeHTML(people, meId) {
  const ids = new Set(people.map((p) => p.userId));
  const byManager = new Map();
  for (const p of people) {
    if (p.userId === meId) continue;
    const parent = p.managerId && ids.has(p.managerId) ? p.managerId : meId;
    if (!byManager.has(parent)) byManager.set(parent, []);
    byManager.get(parent).push(p);
  }
  const seen = new Set();
  const node = (p) => {
    if (seen.has(p.userId)) return "";
    seen.add(p.userId);
    const kids = (byManager.get(p.userId) || []).map(node).join("");
    const over =
      p.overdueActions > 0
        ? '<span class="chip risk">' + p.overdueActions + " quá hạn</span>"
        : '<span class="chip validated">Đúng hạn</span>';
    return (
      "<li>" +
      '<a class="person" href="employee.html?id=' + encodeURIComponent(p.userId) + '">' +
      '<span class="ava">' + esc(initials(p.name)) + "</span>" +
      '<span><span class="nm">' + esc(p.name) + "</span><br>" +
      '<span class="rl">' + esc(p.title || "") + "</span></span>" +
      '<span class="meta"><span class="cnt">' +
      p.canvasCount + " canvas · " + p.publishedCount + " đã chốt</span>" +
      over + "</span></a>" +
      (kids ? "<ul>" + kids + "</ul>" : "") +
      "</li>"
    );
  };
  if (!people.length) return '<p class="note">Chưa có ai trong phạm vi của bạn.</p>';
  const roots = people.filter((p) => p.userId === meId);
  const html = roots.length
    ? roots.map(node).join("")
    : people.map(node).join(""); // actor ngoài list — render phẳng
  return '<ul class="tree">' + html + "</ul>";
}

function canvasRowHTML(c) {
  const chips =
    (STATUS_CHIP[c.status] || "") +
    (c.stage && STAGE_CHIP[c.stage] ? STAGE_CHIP[c.stage] : "");
  const meta =
    c.openActions + " việc mở" +
    (c.overdueActions ? " · " + c.overdueActions + " quá hạn" : "") +
    (c.publishedAt ? " · chốt " + dmy(c.publishedAt) : "");
  return (
    '<a class="week" href="canvas.html?canvas=' + encodeURIComponent(c.id) + '">' +
    '<span><span class="wk">' + esc(c.currentVersionNo ? "v" + c.currentVersionNo : "—") + "</span>" +
    '<span class="wdate">' + esc(c.ownerName) + "</span></span>" +
    '<span><span class="wt">' + esc(c.name) + "</span>" +
    '<span class="wch">' + esc(meta) + "</span></span>" +
    '<span class="wact">' + chips + "</span></a>"
  );
}

/* ---------- Employee page renderers ---------- */
/* Mỗi series là một metric thật (metricId+revision+unit+baseline+target).
 * Trục chung là % tiến độ baseline→target — công thức giống
 * shared/canvas/measurement.ts (scale trước khi trừ để tránh tràn
 * ±Infinity với endpoint cực trị; kết quả không finite trả null). */
function pct(value, baseline, target) {
  const scale = Math.max(Math.abs(value), Math.abs(baseline), Math.abs(target), 1);
  const d = target / scale - baseline / scale;
  if (d === 0) return null;
  const v = ((value / scale - baseline / scale) / d) * 100;
  if (!Number.isFinite(v)) return null;
  return Math.max(-10, Math.min(115, v));
}
const LAYER_COLOR = {
  BEHAVIOR: "#12304C",
  OUTPUT: "#B98A48",
  RESULT: "#2F7A5B",
};
// Human legend label — the metricId is an opaque UUID, meaningless to a
// manager; revision stays in the legend only when it is not v1.
const LAYER_NAME = {
  BEHAVIOR: "Hành vi (BEHAVIOR)",
  OUTPUT: "Đầu ra (OUTPUT)",
  RESULT: "Kết quả (RESULT)",
};
const seriesName = (s) =>
  (LAYER_NAME[s.points[0].layer] || s.points[0].layer) +
  (s.definitionRevision > 1 ? " · định nghĩa v" + s.definitionRevision : "");

function chartHTML(canvas) {
  const series = canvas.series || [];
  if (!series.length) {
    return (
      '<h3 class="title" style="font-size:15px">' + esc(canvas.name) + "</h3>" +
      '<p class="note">Bản đã chốt chưa có số đo — observed evidence ở dạng văn bản, không vẽ xu hướng.</p>'
    );
  }
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  if (dates.length < 2) {
    return (
      '<h3 class="title" style="font-size:15px">' + esc(canvas.name) + "</h3>" +
      '<p class="note">Chưa đủ mốc đo để vẽ xu hướng — cần ít nhất 2 ngày đo khác nhau.</p>'
    );
  }
  // R leaves room for the centred last date label; the y domain matches
  // pct()'s clamp (-10…115) so over-target points stay inside the plot.
  const W = 680, H = 250, L = 44, R = 34, T = 16, B = 34;
  const iw = W - L - R, ih = H - T - B;
  const YMIN = -10, YMAX = 115;
  const x = (d) => L + (dates.indexOf(d) * iw) / (dates.length - 1);
  const y = (v) => T + ih - ((v - YMIN) / (YMAX - YMIN)) * ih;
  let g = "";
  [0, 25, 50, 75, 100].forEach((p) => {
    g += '<line class="grid" x1="' + L + '" y1="' + y(p) + '" x2="' + (W - R) + '" y2="' + y(p) + '"/>' +
      '<text class="lbl" x="' + (L - 8) + '" y="' + (y(p) + 3.5) + '" text-anchor="end">' + p + "%</text>";
  });
  g += '<line class="tgt" x1="' + L + '" y1="' + y(100) + '" x2="' + (W - R) + '" y2="' + y(100) + '"/>' +
    '<line class="axis" x1="' + L + '" y1="' + y(0) + '" x2="' + (W - R) + '" y2="' + y(0) + '"/>';
  dates.forEach((d) => {
    g += '<text class="lbl" x="' + x(d) + '" y="' + (H - 12) + '" text-anchor="middle">' + esc(dmy(d)) + "</text>";
  });
  // Same-layer series share a color — a re-baselined definition (same
  // metricId+revision+unit, different endpoints) would otherwise be
  // indistinguishable, so repeats get a dash variant and the legend
  // carries revision + baseline→target.
  const DASHES = ["", ' stroke-dasharray="7 4"', ' stroke-dasharray="2 3"'];
  const colorUse = {};
  const dashFor = series.map((s) => {
    const c = LAYER_COLOR[s.points[0].layer] || "#5A7185";
    const n = (colorUse[c] = (colorUse[c] || 0) + 1);
    return DASHES[Math.min(n - 1, DASHES.length - 1)];
  });
  series.forEach((s, i) => {
    const color = LAYER_COLOR[s.points[0].layer] || "#5A7185";
    let d = "", started = false, dots = "";
    s.points.forEach((p) => {
      const v = pct(p.value, s.baseline, s.target);
      if (v == null) return;
      d += (started ? " L" : "M") + x(p.date) + " " + y(v);
      started = true;
      dots += '<circle class="dot" cx="' + x(p.date) + '" cy="' + y(v) + '" r="4" fill="' + color + '"><title>' +
        esc(seriesName(s)) + " — " + esc(dmy(p.date)) + ": " + p.value + " " + esc(s.unit) + "</title></circle>";
    });
    if (d) g += '<path class="ln" d="' + d + '" stroke="' + color + '"' + dashFor[i] + "/>" + dots;
  });
  const legend = series
    .map(
      (s, i) =>
        '<span><i style="background:' + (LAYER_COLOR[s.points[0].layer] || "#5A7185") +
        (dashFor[i] ? ";opacity:.55" : "") + '"></i>' +
        esc(seriesName(s)) + " · " + s.baseline + "→" + s.target +
        (s.unit ? " " + esc(s.unit) : "") +
        (s.progressPct != null ? " — " + Math.round(s.progressPct) + "%" : "") + "</span>",
    )
    .join("");
  return (
    '<h3 class="title" style="font-size:15px">' + esc(canvas.name) + "</h3>" +
    '<div class="chartwrap"><svg viewBox="0 0 ' + W + " " + H + '" width="100%" role="img" ' +
    'aria-label="Xu hướng đo lường của ' + esc(canvas.name) + '">' + g + "</svg>" +
    '<div class="legend">' + legend + "</div></div>"
  );
}

/* ---------- Page initializers ---------- */
function wireDashboardTabs() {
  const tabs = [
    ["tab-team", "panel-team"],
    ["tab-mine", "panel-mine"],
  ];
  tabs.forEach(([tid]) => {
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

async function initDashboard(me) {
  const first = me.name.trim().split(/\s+/).slice(-1)[0];
  const ptitle = document.getElementById("ptitle");
  if (ptitle) ptitle.textContent = `Chào ${first}, đây là tình hình hôm nay`;
  const psub = document.getElementById("psub");
  if (psub) psub.textContent = me.title || me.email;

  const attention = document.getElementById("attention");
  const tree = document.getElementById("tree");
  const mine = document.getElementById("mine");
  setLoading(attention, "Ưu tiên hôm nay", "Cần bạn xử lý");
  if (tree) {
    tree.setAttribute("aria-busy", "true");
    tree.innerHTML = '<li class="loading" role="status">Đang tải…</li>';
  }
  setLoading(mine, null, "Canvas cá nhân");

  let data;
  try {
    data = await fetchDashboard();
  } catch (err) {
    if (err.status === 401) return; // redirecting to login
    data = null;
  }

  const failed =
    '<p class="note err-note" role="alert">Không tải được dữ liệu — kiểm tra kết nối rồi thử lại.</p>' +
    RETRY_HTML;
  setLoaded(
    attention,
    data
      ? attentionHTML(data.attention)
      : '<div class="eyebrow">Ưu tiên hôm nay</div><h2 class="title">Cần bạn xử lý</h2>' + failed,
  );
  if (tree) {
    tree.removeAttribute("aria-busy");
    tree.innerHTML = data
      ? treeHTML(data.people, me.id)
      : '<li><p class="note err-note">Không tải được sơ đồ đội ngũ.</p></li>';
  }
  if (mine) {
    const myRows = data
      ? data.canvases.filter((c) => c.ownerUserId === me.id)
      : [];
    setLoaded(
      mine,
      '<h2 class="title">Canvas cá nhân</h2>' +
        (!data
          ? failed
          : myRows.length
            ? '<div class="weeklist">' + myRows.map(canvasRowHTML).join("") + "</div>" +
              '<div class="btnrow" style="margin-top:12px"><a class="btn ghost" href="/canvas-online/">Tạo canvas mới</a></div>'
            : '<p class="note">Bạn chưa có canvas nào. Mở Canvas Online để bắt đầu.</p>' +
              '<div class="btnrow" style="margin-top:10px"><a class="btn ghost" href="/canvas-online/">Mở Canvas Online</a></div>'),
    );
  }
}

/* Employee page: three outcomes kept distinct — the dashboard read failed
 * (network / server → retry), the link has no ?id=, or the person is
 * genuinely outside the caller's scope (policy-filtered server-side). */
async function initEmployee() {
  const personId = new URLSearchParams(location.search).get("id");
  const cname = document.getElementById("cname");
  const head = document.getElementById("head");
  const trend = document.getElementById("trend");
  const list = document.getElementById("list");

  const stop = (crumb, title, body, retry) => {
    if (cname) cname.textContent = crumb;
    setLoaded(
      head,
      '<div class="card" data-state="' + (retry ? "error" : "denied") + '">' +
        '<h1 class="title">' + esc(title) + "</h1>" +
        '<p class="note"' + (retry ? ' role="alert"' : "") + ">" + esc(body) + "</p>" +
        '<div class="btnrow" style="margin-top:12px">' +
        (retry ? '<button class="btn" type="button" data-retry>Thử lại</button>' : "") +
        '<a class="btn ghost" href="dashboard.html">Về bảng theo dõi</a></div></div>',
    );
    if (trend) trend.hidden = true;
    if (list) list.hidden = true;
  };

  if (!personId) {
    stop(
      "Không xem được",
      "Liên kết thiếu thông tin",
      "Liên kết này không chỉ rõ người cần xem. Mở lại từ sơ đồ đội ngũ trên bảng theo dõi.",
      false,
    );
    return;
  }

  setLoading(head, null, null);
  setLoading(trend, "Biến đổi hiệu suất", "Bằng chứng đo được trên bản đã chốt");
  setLoading(list, "Lịch sử", "Các bản canvas đã chốt");

  let data;
  try {
    data = await fetchDashboard();
  } catch (err) {
    if (err.status === 401) return; // redirecting to login
    stop(
      "Lỗi tải dữ liệu",
      "Không tải được dữ liệu",
      err.status === 0
        ? "Không kết nối được máy chủ — kiểm tra mạng rồi thử lại."
        : "Máy chủ chưa trả được dữ liệu (mã " + err.status + ") — thử lại sau ít phút.",
      true,
    );
    return;
  }

  const person = data.people.find((p) => p.userId === personId) || null;
  if (!person) {
    stop(
      "Không xem được",
      "Không xem được hồ sơ này",
      "Người này không nằm trong phạm vi của bạn, hoặc liên kết đã cũ.",
      false,
    );
    return;
  }
  const canvases = data.canvases.filter((c) => c.ownerUserId === personId);

  if (cname) cname.textContent = person.name;
  setLoaded(
    head,
    '<div class="card"><div class="person" style="cursor:default">' +
      '<span class="ava">' + esc(initials(person.name)) + "</span>" +
      '<span><span class="nm" style="font-size:17px">' + esc(person.name) + "</span><br>" +
      '<span class="rl">' + esc(person.title || "") + "</span></span>" +
      '<span class="meta"><span class="cnt">' +
      person.canvasCount + " canvas · " + person.publishedCount + " đã chốt · " +
      person.overdueActions + " quá hạn</span></span></div></div>",
  );
  setLoaded(
    trend,
    '<div class="eyebrow">Biến đổi hiệu suất</div><h2 class="title">Bằng chứng đo được trên bản đã chốt</h2>' +
      (canvases.length
        ? canvases.map(chartHTML).join('<div style="height:18px"></div>')
        : '<p class="note">Chưa có canvas nào trong phạm vi của bạn.</p>'),
  );
  if (!list) return;

  // Lịch sử bản chốt — tải song song per canvas (policy-gated server-side).
  // A failed read is counted, never silently shown as "no versions".
  const lists = await Promise.all(
    canvases.map(async (c) => {
      try {
        const res = await apiFetch(
          "/canvases/" + encodeURIComponent(c.id) + "/versions",
        );
        if (!res.ok) return { canvas: c, versions: [], failed: true };
        return { canvas: c, versions: await res.json(), failed: false };
      } catch {
        return { canvas: c, versions: [], failed: true };
      }
    }),
  );
  const failedCount = lists.filter((x) => x.failed).length;
  const rows = lists
    .flatMap(({ canvas, versions }) => versions.map((v) => ({ canvas, v })))
    .sort((a, b) => String(b.v.publishedAt).localeCompare(String(a.v.publishedAt)));
  setLoaded(
    list,
    '<div class="eyebrow">Lịch sử</div><h2 class="title">Các bản canvas đã chốt</h2>' +
      (failedCount
        ? '<p class="note err-note" role="alert">Không tải được lịch sử của ' +
          failedCount + " canvas — danh sách dưới đây có thể thiếu.</p>" + RETRY_HTML
        : "") +
      (rows.length
        ? '<div class="weeklist">' +
          rows
            .map(
              ({ canvas, v }) =>
                '<a class="week" href="canvas.html?canvas=' + encodeURIComponent(canvas.id) + '">' +
                '<span><span class="wk">v' + v.versionNo + "</span>" +
                '<span class="wdate">' + esc(dmy(v.publishedAt)) + "</span></span>" +
                '<span><span class="wt">' + esc(canvas.name) + "</span>" +
                '<span class="wch">' +
                esc(v.changeSummary || "Bản chốt") +
                (v.publishedByName ? " · " + esc(v.publishedByName) : "") +
                "</span></span>" +
                '<span class="wact"><span class="chip piloting">Bất biến</span></span></a>',
            )
            .join("") +
          "</div>"
        : failedCount
          ? ""
          : '<p class="note">Chưa có bản nào được chốt.</p>'),
  );
}

async function init() {
  const page = document.body.dataset.page;
  // Tabs are wired before any await so a click during the session /
  // dashboard round-trip is never dropped.
  if (page === "dashboard") wireDashboardTabs();

  const identity = await requireAuth(); // { user, roles } — null after redirect
  if (!identity) return;
  const me = identity.user;
  renderAppHeader(identity, {
    current: page === "canvas" ? "canvas" : "dashboard",
  });
  // Footer before branding: applyBranding rewrites every [data-brand-name]
  // present when it resolves, so the footer must already exist.
  renderAppFooter();
  loadBranding().then(applyBranding);

  if (page === "dashboard") await initDashboard(me);
  if (page === "employee") await initEmployee();

  if (page === "canvas") {
    // Task 2.5: the real editor lives at /canvas-online/?canvas=<id> —
    // this page just forwards (same query param) or links over.
    const app = document.getElementById("app");
    const params = new URLSearchParams(location.search);
    const canvasId = params.get("canvas") || params.get("id");
    if (canvasId) {
      location.replace(
        `/canvas-online/?canvas=${encodeURIComponent(canvasId)}`,
      );
      return;
    }
    const cname = document.getElementById("vname");
    if (cname) cname.textContent = "Canvas chi tiết";
    if (app) {
      app.innerHTML =
        '<div class="card"><h1 class="title">Canvas chi tiết</h1>' +
        '<p class="note">Canvas Online đã mở — bản nháp lưu trên máy chủ, ' +
        "chốt phiên bản bất biến, có lịch sử khôi phục. Mở một canvas cụ thể " +
        "từ danh sách để chỉnh sửa.</p>" +
        '<div class="btnrow" style="margin-top:12px">' +
        '<a class="btn ghost" href="/canvas-online/">Mở Canvas Online</a>' +
        '<a class="btn ghost" href="dashboard.html">Về bảng theo dõi</a></div></div>';
    }
  }
}

init();
