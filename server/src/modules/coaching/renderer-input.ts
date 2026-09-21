import { AppError } from "../../shared/errors.js";

/**
 * Report → Renderer bridge extraction (task 4.3, spec §6).
 *
 * A coaching report may feed a renderer run ONLY through this whitelist:
 * the actor picks field keys, the server extracts just those sections —
 * never the whole report, never coach scores, never transcript text. The
 * body is an ORACLE markdown document; anything that can carry evidence
 * (labeled lines, quoted spans) is stripped to bare recommendation prose
 * before it may leave the report boundary.
 */

export const REPORT_BRIDGE_FIELDS = [
  "priorities",
  "followUp",
  "nextSession",
] as const;

export type ReportBridgeField = (typeof REPORT_BRIDGE_FIELDS)[number];

export const REPORT_BRIDGE_INVALID = "REPORT_BRIDGE_INVALID";
export const REPORT_BRIDGE_EMPTY = "REPORT_BRIDGE_EMPTY";

interface OracleBody {
  format?: string;
  markdown?: string;
}

const QUOTED_SPAN = /“[^”]*”|"([^"\\]*(?:\\.[^"\\]*)*)"/g;
const LABEL_RE = /^\s*(?:[-*]\s+)?(?:\*\*)?\[([^\]]+)\](?:\*\*)?\s*/;

/** Strip every quoted span — evidence excerpts must not cross the bridge. */
function stripQuoted(text: string): string {
  return text.replaceAll(QUOTED_SPAN, "…").replaceAll(/\s+/g, " ").trim();
}

/**
 * Prose of a closing-section line. Evidence labels never cross: a
 * [Bằng chứng trực tiếp] line exists to carry a transcript quote and a
 * [Thiếu bằng chứng] line asserts absence — neither is a recommendation.
 * [Diễn giải] prose (interpretation) survives with the label dropped and
 * any embedded quote removed; unlabeled prose survives too — except rubric
 * housekeeping ("Ghi chú:"), which is never a coaching recommendation.
 */
function recommendationLine(line: string): string | null {
  const label = LABEL_RE.exec(line)?.[1];
  if (label === "Bằng chứng trực tiếp" || label === "Thiếu bằng chứng") {
    return null;
  }
  const unlabeled = line.replace(LABEL_RE, "");
  const clean = stripQuoted(unlabeled);
  if (!clean) return null;
  if (/^ghi chú/i.test(clean)) return null;
  return clean;
}

function tierOne(markdown: string): string {
  const idx = markdown.search(/^##\s+Tầng 2/im);
  return idx === -1 ? markdown : markdown.slice(0, idx);
}

/** The trailing "## Follow-up …" / "## Chuẩn bị …" block of the report. */
function closingSection(markdown: string): string {
  const headings = [...markdown.matchAll(/^##\s+[^\n]+/gm)];
  const closing = headings.filter((m) =>
    /follow-?up|chuẩn bị|phiên tiếp/i.test(m[0]),
  );
  if (closing.length === 0) return "";
  const start = closing[closing.length - 1]!.index!;
  return markdown.slice(start);
}

/**
 * Extract the user-selected recommendation fields from a validated ORACLE
 * report body. A field that produces no text is skipped; if the selection
 * yields nothing at all the bridge has nothing to feed — 422.
 */
export function extractRendererNotes(
  body: unknown,
  fields: readonly ReportBridgeField[],
): string {
  const b = body as OracleBody | null;
  if (b?.format !== "oracle-md-3.0" || typeof b.markdown !== "string") {
    throw new AppError(
      422,
      REPORT_BRIDGE_INVALID,
      "Report không phải định dạng ORACLE — không thể làm input Renderer",
    );
  }
  const md = b.markdown;
  const parts: string[] = [];

  for (const field of fields) {
    if (field === "priorities") {
      const m = /ba ưu tiên[^\n]*/i.exec(tierOne(md));
      const text = m ? stripQuoted(m[0].replace(/^ba ưu tiên\s*:?\s*/i, "")) : "";
      if (text) parts.push(`Ưu tiên cải thiện: ${text}`);
      continue;
    }
    const closing = closingSection(md);
    const marker = /chuẩn bị phiên tiếp theo/i;
    const splitAt = closing.search(marker);
    const region =
      field === "followUp"
        ? splitAt === -1
          ? closing
          : closing.slice(0, splitAt)
        : splitAt === -1
          ? ""
          : closing.slice(splitAt);
    const lines = region
      .split("\n")
      .filter((l) => !/^#{1,6}\s/.test(l))
      .map(recommendationLine)
      .filter((l): l is string => l !== null);
    if (lines.length > 0) {
      parts.push(
        field === "followUp"
          ? `Follow-up: ${lines.join(" ")}`
          : `Chuẩn bị phiên tiếp theo: ${lines.join(" ")}`,
      );
    }
  }

  if (parts.length === 0) {
    throw new AppError(
      422,
      REPORT_BRIDGE_EMPTY,
      "Report không có nội dung khuyến nghị cho các mục đã chọn",
    );
  }
  return parts.join("\n");
}
