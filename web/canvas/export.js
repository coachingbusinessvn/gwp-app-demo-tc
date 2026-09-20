/**
 * web/canvas/export.js — authorized export boundary client (task 2.7).
 *
 * Exports are server-mediated so every artifact that leaves the system is
 * authorized by the subject policy AND audited (canvas.export, format/id
 * metadata only — never content). Rendering stays client-side: the XLSX
 * writer and preview printer live in model.js; Markdown for published
 * versions is rendered server-side so the response can carry the exact
 * loss warnings.
 *
 *   exportDraftPreview(canvasId) → {body, revision, markdown, warnings}|null
 *   exportPublished(canvasId, versionId, format) → {body|markdown, warnings}|null
 */
import { apiFetch } from "../api.js";

/**
 * The CURRENT draft export payload — null when the canvas has no live
 * draft (publish consumed it) or the caller lost access. Both cases read
 * the same to the caller; the UI states it plainly.
 */
export async function exportDraftPreview(canvasId) {
  const res = await apiFetch(
    `/canvases/${canvasId}/export-preview`,
    { method: "POST" },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`export-preview ${res.status}`);
  return res.json();
}

/**
 * Published snapshot export — format "json" (lossless) or "markdown"
 * (loss-aware; warnings list what the format dropped). null on 404 —
 * denied and missing are deliberately indistinguishable.
 */
export async function exportPublished(canvasId, versionId, format) {
  const res = await apiFetch(
    `/canvases/${canvasId}/versions/${versionId}/export?format=${format}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`export ${res.status}`);
  return res.json();
}
