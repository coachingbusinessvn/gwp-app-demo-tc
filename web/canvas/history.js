/**
 * web/canvas/history.js — immutable published-version history (task 2.5).
 *
 * Panel over GET /canvases/:id/versions (summaries only — bodies come
 * from the single-version endpoint on demand). Per row: "v{n} · người
 * chốt · ngày · ghi chú" + Xem (read-only preview) / JSON / Markdown /
 * Khôi phục. Every dynamic string renders via textContent / esc() —
 * version bodies are user content.
 *
 * The host page supplies:
 *   - apiFetch (web/api.js) for all requests,
 *   - confirmRestore(version) → Promise<boolean>|boolean — the explicit
 *     user confirmation + CAS inputs ({expectedRevision, confirm}) are
 *     decided by the caller,
 *   - onRestored(draftDto) — the restored draft replaces the live state,
 *   - renderPreviewInto(el, body) — safe preview renderer,
 *   - download(blob, filename) + slugFor(body).
 */
import { apiFetch } from "../api.js";
import { buildMarkdown, previewHtml } from "./model.js";
import { GWP_LOGO } from "./logo.js";

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso)
    : d.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
};

export function createHistoryPanel({
  canvasId,
  panel, // section[data-testid=history-panel]
  listEl, // container for version rows
  viewEl, // div[data-testid=version-view] — readonly preview host
  getDraftRevision, // () => number | null  (null when no live draft)
  onRestored, // (draftDto) => void
  onError, // (message) => void
  download, // (blob, filename) => void
}) {
  let versions = null; // cached summaries (newest first from the API)

  function versionLabel(v) {
    return `v${v.versionNo}`;
  }

  function fileStem(v) {
    return `canvas-${canvasId.slice(0, 8)}-v${v.versionNo}`;
  }

  async function fetchVersions() {
    const res = await apiFetch(`/canvases/${canvasId}/versions`);
    if (res.status === 404) {
      onError?.("Bạn không có quyền xem lịch sử canvas này.");
      return null;
    }
    if (!res.ok) {
      onError?.("Không tải được lịch sử phiên bản — thử lại sau.");
      return null;
    }
    return res.json();
  }

  async function fetchVersion(versionId) {
    const res = await apiFetch(
      `/canvases/${canvasId}/versions/${versionId}`,
    );
    if (!res.ok) {
      onError?.("Không tải được phiên bản — có thể bạn không có quyền.");
      return null;
    }
    return res.json();
  }

  function renderList() {
    listEl.replaceChildren();
    if (!versions || versions.length === 0) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "Chưa có phiên bản nào được chốt.";
      listEl.appendChild(p);
      return;
    }
    for (const v of versions) {
      const row = document.createElement("div");
      row.className = "version-row";
      row.dataset.testid = "version-row";

      const head = document.createElement("div");
      head.className = "version-head";
      const no = document.createElement("b");
      no.className = "version-no";
      no.textContent = versionLabel(v);
      const meta = document.createElement("span");
      meta.className = "version-meta";
      const who = v.publishedByName || v.publishedBy;
      meta.textContent = `${who} · ${fmtDate(v.publishedAt)} · id ${v.id.slice(0, 8)}…`;
      head.append(no, meta);
      row.appendChild(head);

      if (v.changeSummary) {
        const cs = document.createElement("div");
        cs.className = "version-summary";
        cs.textContent = v.changeSummary;
        row.appendChild(cs);
      }

      const actions = document.createElement("div");
      actions.className = "version-actions";

      const btnView = document.createElement("button");
      btnView.type = "button";
      btnView.className = "add";
      btnView.textContent = "Xem";
      btnView.addEventListener("click", async () => {
        const full = await fetchVersion(v.id);
        if (!full) return;
        viewEl.innerHTML = previewHtml(full.body, GWP_LOGO);
        viewEl.hidden = false;
        viewEl.scrollIntoView({ block: "nearest" });
      });

      const btnJson = document.createElement("button");
      btnJson.type = "button";
      btnJson.className = "add";
      btnJson.textContent = "JSON";
      btnJson.addEventListener("click", async () => {
        const full = await fetchVersion(v.id);
        if (!full) return;
        download(
          new Blob([JSON.stringify(full.body, null, 2)], {
            type: "application/json",
          }),
          `${fileStem(v)}.json`,
        );
      });

      const btnMd = document.createElement("button");
      btnMd.type = "button";
      btnMd.className = "add";
      btnMd.textContent = "Markdown";
      btnMd.addEventListener("click", async () => {
        const full = await fetchVersion(v.id);
        if (!full) return;
        download(
          new Blob([buildMarkdown(full.body)], { type: "text/markdown" }),
          `${fileStem(v)}.md`,
        );
      });

      const btnRestore = document.createElement("button");
      btnRestore.type = "button";
      btnRestore.className = "add";
      btnRestore.textContent = "Khôi phục";
      btnRestore.addEventListener("click", async () => {
        const ok = window.confirm(
          `Khôi phục ${versionLabel(v)} vào bản nháp hiện tại? Nội dung nháp đang sửa sẽ được thay bằng nội dung phiên bản này.`,
        );
        if (!ok) return;
        const revision = getDraftRevision();
        const payload =
          revision === null
            ? {}
            : { expectedRevision: revision, confirm: true };
        const res = await apiFetch(
          `/canvases/${canvasId}/versions/${v.id}/restore`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (res.status === 409) {
          onError?.(
            "Khôi phục bị xung đột — bản nháp vừa thay đổi. Tải lại trang rồi thử lại.",
          );
          return;
        }
        if (!res.ok) {
          onError?.("Không khôi phục được phiên bản — thử lại sau.");
          return;
        }
        const draft = await res.json();
        onRestored?.(draft);
      });

      actions.append(btnView, btnJson, btnMd, btnRestore);
      row.appendChild(actions);
      listEl.appendChild(row);
    }
  }

  return {
    /** Toggle open; fetches fresh each open. */
    async open() {
      panel.hidden = !panel.hidden;
      if (panel.hidden) return;
      viewEl.hidden = true;
      viewEl.replaceChildren();
      listEl.textContent = "Đang tải…";
      versions = await fetchVersions();
      renderList();
    },
    /** Force a reload next open (called after publish/restore). */
    invalidate() {
      versions = null;
    },
    isOpen() {
      return !panel.hidden;
    },
    close() {
      panel.hidden = true;
    },
  };
}
