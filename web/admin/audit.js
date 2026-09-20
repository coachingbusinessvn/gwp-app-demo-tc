/* web/admin/audit.js — Nhật ký tab (task 1.5, spec §9): the metadata-only
 * audit viewer. The server returns the fixed DTO set only; everything the
 * table shows lands via textContent — safe_metadata is rendered as a JSON
 * string, never as markup.
 */
import { el, miniButton, reqJson, showError } from "./http.js";

function box() {
  const b = el("p", "err");
  b.setAttribute("role", "alert");
  b.style.color = "var(--risk)";
  b.style.fontSize = "12.5px";
  b.hidden = true;
  return b;
}

export function mountAudit(panel) {
  const card = el("section", "card");
  card.append(el("div", "eyebrow", "Kiểm toán"));
  card.append(el("h2", "title", "Nhật ký audit"));
  card.append(
    el(
      "p",
      "note",
      "Chỉ metadata vận hành — hành động, kết quả, đối tượng và các khoá metadata được phép. Không có nội dung coaching hay giá trị nhạy cảm.",
    ),
  );
  const err = box();
  const wrap = el("div", "tscroll");
  const table = el("table", "t");
  const thead = el("thead");
  const headRow = el("tr");
  for (const h of [
    "Thời điểm",
    "Hành động",
    "Kết quả",
    "Đối tượng",
    "Metadata",
    "Request",
  ]) {
    headRow.append(el("th", null, h));
  }
  thead.append(headRow);
  const tbody = el("tbody");
  table.append(thead, tbody);
  wrap.append(table);
  const more = miniButton("Tải thêm");
  more.hidden = true;
  card.append(err, wrap, more);
  panel.append(card);

  let nextCursor = null;

  function renderRows(items) {
    for (const ev of items) {
      const tr = el("tr");
      tr.append(
        el("td", null, new Date(ev.at).toLocaleString("vi-VN")),
        el("td", null, ev.action),
        el("td", null, ev.outcome),
        el(
          "td",
          null,
          ev.targetType === null
            ? "—"
            : `${ev.targetType}${ev.targetId ? ` ${ev.targetId.slice(0, 8)}…` : ""}`,
        ),
        el("td", null, JSON.stringify(ev.metadata ?? {})),
        el("td", null, ev.requestId ? `${ev.requestId.slice(0, 8)}…` : "—"),
      );
      tbody.append(tr);
    }
  }

  async function load(cursor) {
    const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page = await reqJson("GET", `/audit?limit=25${q}`);
    renderRows(page.items);
    nextCursor = page.nextCursor;
    more.hidden = nextCursor === null;
  }

  more.addEventListener("click", () => {
    load(nextCursor).catch((e) => showError(err, e));
  });
  load(null).catch((e) => showError(err, e));
}
