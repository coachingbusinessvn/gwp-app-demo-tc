/**
 * web/coaching/report.js — saved ORACLE reports on the coaching page
 * (task 4.4, spec §6).
 *
 * - The list is GET /reports — the server's ACL decides what shows up.
 * - Detail renders ONLY from a fresh authorized fetch (never a cached
 *   or preloaded copy): body.markdown is rendered through a strict
 *   escaping renderer — report text can never execute as markup.
 * - Export (print / .md download) uses the currently fetched body.
 * - "Dùng trong Renderer" opens the canvas editor with ?report=<id> —
 *   the panel's bridge sends only the selected whitelist fields, and the
 *   server re-checks BOTH the report-read and canvas-write ACLs.
 * - Delete is a confirmed DELETE — the confirm flag travels in the body.
 */
import { apiFetch, apiFetchAll } from "../api.js";
import { readFriendlyError } from "../ai/status.js";
import { mountSharing } from "./sharing.js";

const LABEL_CLASS = {
  "Bằng chứng trực tiếp": "ev-direct",
  "Diễn giải": "ev-interp",
  "Thiếu bằng chứng": "ev-missing",
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function readError(res) {
  return (await readFriendlyError(res)).message;
}

/**
 * Strict ORACLE-markdown → safe HTML. Everything is escaped first; only a
 * small whitelist of structures is re-emitted: headings, bold, lists,
 * blockquotes and the three cognition labels as badges. Any tag the model
 * wrote stays inert text.
 */
export function renderOracleReport(output) {
  const host = el("div", "oracle-report");
  if (!output || typeof output.markdown !== "string") {
    host.append(el("p", "note", "(không có nội dung report)"));
    return host;
  }
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  for (const raw of output.markdown.split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${esc(h[2]).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderLine(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") continue;
    if (line.startsWith("> ")) {
      html.push(`<blockquote>${renderLine(line.slice(2))}</blockquote>`);
      continue;
    }
    html.push(`<p>${renderLine(line)}</p>`);
  }
  closeList();
  host.innerHTML = html.join("\n");
  return host;

  function renderLine(l) {
    const m = /^\s*(?:\*\*)?\[([^\]]+)\](?:\*\*)?\s*/.exec(l);
    const label = m?.[1];
    const badge =
      label && LABEL_CLASS[label]
        ? `<span class="ev-label ${LABEL_CLASS[label]}">${esc(label)}</span>`
        : "";
    const rest = m ? l.slice(m[0].length) : l;
    return (
      badge + esc(rest).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    );
  }
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("vi-VN");
  } catch {
    return iso;
  }
}

function download(filename, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 2000);
}

/**
 * @param host the detail host inside the detail card
 * @param opts {identity, listEl, emptyEl, onRegrade, onListed}
 *   onListed(items) fires after each list refresh (the session card marks
 *   which sessions already carry a report).
 */
export function mountReports(
  host,
  { identity, listEl, emptyEl, onRegrade, onListed },
) {
  const card = host.closest("section.card") ?? host.parentElement;
  let users = [];
  let canvases = [];
  let items = [];

  function userName(id) {
    const u = users.find((x) => x.id === id);
    return u ? u.name : id.slice(0, 8);
  }

  /** Every page of each list — never silently truncated at one page. */
  async function refresh() {
    const [usersR, listR, canvasR] = await Promise.allSettled([
      apiFetchAll("/users?limit=100"),
      apiFetchAll("/reports?limit=100"),
      apiFetchAll("/canvases?limit=100"),
    ]);
    if (usersR.status === "fulfilled") users = usersR.value;
    if (canvasR.status === "fulfilled") canvases = canvasR.value;
    if (listR.status === "rejected") {
      listEl.replaceChildren(
        el(
          "p",
          "note",
          "Không tải được danh sách báo cáo — kiểm tra kết nối rồi tải lại trang.",
        ),
      );
      return;
    }
    items = listR.value;
    renderList();
    onListed?.(items);
  }

  function renderList() {
    listEl.replaceChildren();
    emptyEl.hidden = items.length > 0;
    for (const r of items) {
      const row = el("div", "report-row");
      row.dataset.reportRow = r.id;
      const meta = el("div", "meta");
      meta.innerHTML =
        `<b>${esc(userName(r.coacheeUserId))}</b> · coach ${esc(userName(r.coachUserId))}` +
        ` · ${esc(fmtDate(r.createdAt))} · ${esc(r.rubricVersion ?? "—")}`;
      row.append(
        el("span", "ver", `v${r.reportVersion}`),
        meta,
        Object.assign(el("button", "act", "Mở"), {
          type: "button",
          onclick: () => void open(r.id),
        }),
        Object.assign(el("button", "act", "Chấm lại phiên"), {
          type: "button",
          onclick: () => {
            // The reports API doesn't carry occurredAt — the report's own
            // createdAt is the best label available for the picklist.
            onRegrade?.(r.sessionId, {
              coachUserId: r.coachUserId,
              coacheeUserId: r.coacheeUserId,
              occurredAt: r.createdAt,
            });
            document
              .getElementById("graderCard")
              ?.scrollIntoView({ behavior: "smooth" });
          },
        }),
      );
      listEl.append(row);
    }
  }

  /** Open one report — a fresh authorized fetch is the only data source. */
  async function open(reportId) {
    const res = await apiFetch(`/reports/${reportId}`);
    if (res.status === 404) {
      host.replaceChildren(
        el("p", "note", "Báo cáo không tồn tại hoặc bạn không có quyền xem."),
      );
      card.hidden = false;
      return;
    }
    if (!res.ok) {
      host.replaceChildren(
        el("p", "note", `Không tải được báo cáo: ${await readError(res)}`),
      );
      card.hidden = false;
      return;
    }
    const report = await res.json();
    renderDetail(report);
    card.hidden = false;
    card.scrollIntoView({ behavior: "smooth" });
  }

  function renderDetail(report) {
    host.replaceChildren();
    host.dataset.testid = "report-detail";
    host.dataset.reportId = report.id;

    const canManage =
      identity.roles.includes("owner") ||
      report.coachUserId === identity.user.id;

    const title = el("h2", "step-title", `Báo cáo v${report.reportVersion}`);
    const meta = el("p", "note");
    meta.innerHTML =
      `<b>${esc(userName(report.coacheeUserId))}</b> · coach ${esc(userName(report.coachUserId))}` +
      ` · phiên ${esc(fmtDate(report.occurredAt))} · lưu ${esc(fmtDate(report.createdAt))}` +
      ` · rubric ${esc(report.rubricVersion ?? "—")}` +
      ` · model ${esc(report.provenance?.model ?? "—")}`;

    const warn = el(
      "p",
      "stage-note",
      "Điểm và nhận xét do AI nội bộ tạo — hỗ trợ phát triển coach. " +
        "Nhãn [Bằng chứng trực tiếp] là trích nguyên văn transcript; " +
        "[Diễn giải] là suy luận của model; [Thiếu bằng chứng] nghĩa là transcript không có bằng chứng. " +
        "Quyết định nhân sự luôn do con người đưa ra.",
    );

    const body = renderOracleReport(report.body);

    /* Actions: export + renderer bridge + delete */
    const actions = el("div", "report-actions");
    const printBtn = Object.assign(el("button", "act", "🖨 In / Lưu PDF"), {
      type: "button",
      onclick: () => window.print(),
    });
    const mdBtn = Object.assign(el("button", "act", "⬇ Markdown"), {
      type: "button",
      onclick: () =>
        download(
          `coaching-report-v${report.reportVersion}-${report.id.slice(0, 8)}.md`,
          report.body?.markdown ?? "",
          "text/markdown;charset=utf-8",
        ),
    });
    actions.append(printBtn, mdBtn);

    // Bridge: the report's own canvas when linked, else a picker over the
    // canvases the actor may read (the server still enforces write).
    const bridgeWrap = el("span");
    const bridgeCanvas = document.createElement("select");
    bridgeCanvas.setAttribute("aria-label", "Canvas đích cho Renderer");
    const bridgeable = canvases.filter((c) => c.status === "active");
    bridgeCanvas.replaceChildren(
      ...bridgeable.map((c) =>
        Object.assign(el("option"), { value: c.id, textContent: c.name }),
      ),
    );
    if (report.canvasId) bridgeCanvas.value = report.canvasId;
    const bridgeBtn = Object.assign(el("button", "act", "Dùng trong Renderer"), {
      type: "button",
      onclick: () => {
        const cid = bridgeCanvas.value;
        if (!cid) return;
        location.assign(
          `/canvas-online/?canvas=${encodeURIComponent(cid)}&report=${encodeURIComponent(report.id)}`,
        );
      },
    });
    if (bridgeable.length > 0) bridgeWrap.append(bridgeCanvas, bridgeBtn);
    actions.append(bridgeWrap);

    host.append(title, meta, warn, body, actions);

    if (canManage) {
      mountSharing(host, {
        report,
        users,
        onChanged: () => void refresh(),
      });

      const delBtn = Object.assign(el("button", "danger", "Xóa báo cáo"), {
        type: "button",
        onclick: async () => {
          if (
            !window.confirm(
              `Xóa vĩnh viễn báo cáo v${report.reportVersion}? Hành động này xóa nội dung và mọi chia sẻ — không hoàn tác được.`,
            )
          ) {
            return;
          }
          const res = await apiFetch(`/reports/${report.id}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true }),
          });
          if (res.status === 204) {
            card.hidden = true;
            host.replaceChildren();
            host.removeAttribute("data-testid");
            delete host.dataset.reportId;
            await refresh();
          } else {
            window.alert(`Không xóa được: ${await readError(res)}`);
          }
        },
      });
      const delWrap = el("div", "report-actions no-print");
      delWrap.append(delBtn);
      host.append(delWrap);
    }
  }

  return { refresh, open };
}
