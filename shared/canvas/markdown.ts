import { z } from "zod";
import { newId } from "./defaults.js";
import {
  ACTION_STATUSES,
  BUILD_MODES,
  CANVAS_BUSINESS_SCHEMA,
  CANVAS_PAYLOAD_VERSION,
  CANVAS_STAGES,
  CONFIDENCE_LEVELS,
  CanvasBodySchema,
  EVIDENCE_LAYERS,
  GAP_LEVELS,
  PRIORITY_LEVELS,
  REVIEW_DECISIONS,
  SIX_BOXES,
  type CanvasBody,
} from "./schema.js";
import type { Issue } from "./validation.js";

/**
 * Canonical ⇄ Markdown adapter — the format the legacy editor writes and
 * reads (canvas-online/index.html `buildMarkdown`/`parseCanvasMarkdown`),
 * hardened so user content is never silently dropped or mangled.
 *
 * Contract (docs/contracts/canvas-payload.md §Markdown):
 *  - `parseMarkdown` never throws: malformed or missing sections produce
 *    Issue entries with paths and the body still comes back with blanks
 *    (house style from legacy.ts). A document with no canvas title AND no
 *    numbered section is not a canvas → `{ body: null }` + blocking issue.
 *  - Box→behavior links travel as behavior *names* (Markdown carries no
 *    ids). They resolve by exact trimmed-name match only — zero or
 *    multiple hits → blocking `AMBIGUOUS_OR_MISSING_REFERENCE` issue, the
 *    row is preserved, `behavior_id` stays null (never a guess).
 *  - Table-cell escaping is reversible both directions: `\` → `\\`,
 *    `|` → `\|`, `*` → `\*`, newline → `\n`, `(` → `\(` only when needed
 *    to protect a placeholder-looking cell. Placeholder cells (`TBD`,
 *    `(chưa điền)`, `—`) normalize to `""` on import — the schema-3.0
 *    "chưa có dữ liệu" semantic, not content.
 *  - `toMarkdown` emits canvas content only: no row ids, no
 *    `assignee_user_id`, no company/owner fields. Fields Markdown cannot
 *    carry (measurement extension, assignee ids) warn
 *    `JSON_REQUIRED_FOR_EXTENSIONS` — JSON export stays the lossless path.
 */

export interface MarkdownImport {
  body: CanvasBody | null;
  issues: Issue[];
}

export interface MarkdownExport {
  text: string;
  warnings: string[];
}

const err = (code: string, path: string, message: string): Issue => ({
  severity: "error",
  code,
  path,
  message,
});

const warn = (code: string, path: string, message: string): Issue => ({
  severity: "warning",
  code,
  path,
  message,
});

const ISO_DATE = z.iso.date();

/**
 * Placeholder cells carry no content — a whole cell that is only a
 * placeholder normalizes to "" on import (same rule the legacy importer
 * applies, extended with the bare dash the contract notes).
 */
const PLACEHOLDER_RE =
  /^(?:\((?:chưa điền|chưa đặt tên|chưa có dữ liệu)\)|TBD|[—–]+)$/i;

/* ------------------------------------------------------------------ *
 *  Cell escaping — fully reversible                                    *
 * ------------------------------------------------------------------ */

/**
 * Escape one table-cell value for Markdown. Returns the cell text plus a
 * flag set when the raw value *is* a placeholder — the emitted cell would
 * reimport as "" and no escaping can prevent that (the placeholder
 * grammar owns those exact strings).
 */
function mdCell(v: string): { cell: string; placeholderCollision: boolean } {
  let s = v.trim();
  s = s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\*/g, "\\*")
    .replace(/\r\n|\r|\n/g, "\\n");
  if (PLACEHOLDER_RE.test(s)) {
    // A literal placeholder cell would reimport as blank. "(" placeholders
    // survive by escaping the first char; anything else (TBD, —) collides.
    if (/^[(*\\|]/.test(s)) return { cell: `\\${s}`, placeholderCollision: false };
    return { cell: s, placeholderCollision: true };
  }
  return { cell: s, placeholderCollision: false };
}

/** Reverse mdCell's escapes. Unknown `\x` keeps both chars — never drop. */
function unescapeCell(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1]!;
      if (n === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (n === "r") {
        out += "\r";
        i++;
        continue;
      }
      if (n === "|" || n === "\\" || n === "*" || n === "(" || n === ")") {
        out += n;
        i++;
        continue;
      }
      // unknown escape — keep the backslash and the char verbatim
    }
    out += ch;
  }
  return out;
}

/**
 * Text normalization shared by cells and prose: trim, unwrap whole-value
 * `**…**`/`*…*` emphasis (hand-formatted docs), map placeholder-only
 * values to "". Interior markup is preserved — nothing else is stripped.
 */
function normalizeText(s: string): string {
  let t = s.trim();
  // Only unwrap pure emphasis wrappers (`**x**`, `*x`); a value like
  // `**a** … **b**` is real content — the greedy legacy regex would eat it.
  t = t
    .replace(/^\*\*([^*]*)\*\*$/, "$1")
    .replace(/^\*([^*]*)\*$/, "$1")
    .trim();
  if (PLACEHOLDER_RE.test(t)) return "";
  return t;
}

/** Table-cell cleanup: normalize on the still-escaped text, then unescape. */
function cleanCell(raw: string): string {
  return unescapeCell(normalizeText(raw));
}

/* ------------------------------------------------------------------ *
 *  Row/table scanning (ported from legacy parseCanvasMarkdown)         *
 * ------------------------------------------------------------------ */

/**
 * Split a Markdown table row into raw (still-escaped) cells, splitting
 * only on unescaped `|`. A trailing unescaped `|` is the row closer, not
 * a final empty cell.
 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const rawCells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      cur += s.slice(i, i + 2);
      i++;
      continue;
    }
    if (ch === "|") {
      rawCells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  rawCells.push(cur);
  if (rawCells.length > 1 && rawCells[rawCells.length - 1]!.trim() === "") {
    rawCells.pop();
  }
  return rawCells;
}

function isSepRow(line: string): boolean {
  const s = line.trim();
  return /^\|?[\s:|\-]+\|?$/.test(s) && s.includes("-");
}

interface MdTable {
  headers: string[];
  rows: string[][];
  /** line-index span [header, last row] inside the section line array */
  span: [number, number];
}

function mdTablesIn(lines: string[]): MdTable[] {
  const tables: MdTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i]!.trim().startsWith("|") &&
      i + 1 < lines.length &&
      isSepRow(lines[i + 1]!)
    ) {
      const headers = splitRow(lines[i]!);
      const rows: string[][] = [];
      let j = i + 2;
      for (
        ;
        j < lines.length &&
        lines[j]!.trim().startsWith("|") &&
        !isSepRow(lines[j]!);
        j++
      ) {
        rows.push(splitRow(lines[j]!));
      }
      tables.push({ headers, rows, span: [i, j - 1] });
      i = j - 1;
    }
  }
  return tables;
}

/** Pad/truncate a row to k cells — the difference is always an Issue. */
function fitRow(
  r: string[],
  k: number,
  ctx: string,
  path: string,
  issues: Issue[],
): string[] {
  if (r.length === k) return r;
  if (r.length > k) {
    const dropped = r.slice(k).map(cleanCell).filter((c) => c !== "");
    issues.push(
      warn(
        "COLUMN_COUNT_MISMATCH",
        path,
        `${ctx}: dòng có ${r.length} ô thay vì ${k} — căn lại theo ${k} cột chuẩn` +
          (dropped.length
            ? `, các ô bị lược: ${JSON.stringify(dropped).slice(0, 160)}`
            : "") +
          ". Kiểm tra lại.",
      ),
    );
    return r.slice(0, k);
  }
  issues.push(
    warn(
      "COLUMN_COUNT_MISMATCH",
      path,
      `${ctx}: dòng có ${r.length} ô thay vì ${k} — các ô cuối để trống, kiểm tra lại.`,
    ),
  );
  return [...r, ...Array<string>(k - r.length).fill("")];
}

/**
 * Grab the value after a `**Label:**` marker, joining continuation lines
 * of the same paragraph (legacy grabLabeled). Returns the value and the
 * line-index span consumed.
 */
function grabLabeled(
  lines: string[],
  re: RegExp,
): { value: string; span: [number, number] } | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.trim().match(re);
    if (!m) continue;
    let val = m[1]!.trim();
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trim();
      if (
        !t ||
        t.startsWith("|") ||
        t.startsWith("#") ||
        t.startsWith("**") ||
        t.startsWith("*(") ||
        t.startsWith("- ") ||
        t.startsWith("• ")
      ) {
        break;
      }
      val += " " + t;
      last = j;
    }
    return { value: val, span: [i, last] };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Value coercion — Issue-flavored versions of the legacy.ts helpers   *
 * ------------------------------------------------------------------ */

/** Blankable enum: blank stays "", anything else must match exactly. */
function mdEnumOpt<T extends readonly string[]>(
  v: string,
  options: T,
  ctx: string,
  path: string,
  issues: Issue[],
): T[number] | "" {
  const s = v.trim();
  if (s === "") return "";
  if ((options as readonly string[]).includes(s)) return s as T[number];
  issues.push(
    warn(
      "INVALID_ENUM",
      path,
      `${ctx}: giá trị "${s}" không thuộc danh sách chuẩn (${options.join(" / ")}) — để trống, chọn lại.`,
    ),
  );
  return "";
}

/** Required enum: absent/blank or invalid → warn + explicit fallback. */
function mdEnumReq<T extends readonly string[]>(
  v: string,
  options: T,
  fallback: T[number],
  ctx: string,
  path: string,
  issues: Issue[],
): T[number] {
  const s = v.trim();
  if (s === "") {
    issues.push(
      warn(
        "INVALID_ENUM",
        path,
        `${ctx}: thiếu giá trị — đặt "${fallback}", kiểm tra lại.`,
      ),
    );
    return fallback;
  }
  if ((options as readonly string[]).includes(s)) return s as T[number];
  issues.push(
    warn(
      "INVALID_ENUM",
      path,
      `${ctx}: giá trị "${s}" không thuộc danh sách chuẩn (${options.join(" / ")}) — đặt "${fallback}".`,
    ),
  );
  return fallback;
}

/**
 * Date-typed fields (same rules as legacy.ts asIsoDate): a bare ISO
 * YYYY-MM-DD must be a real calendar date; anchored DD/MM/YYYY normalizes;
 * an ISO substring embedded in text is kept with a warning; anything else
 * warns and blanks — a wrong-shaped date never reaches the body.
 */
function mdDate(
  v: string,
  ctx: string,
  path: string,
  issues: Issue[],
): string {
  const s = v.trim();
  if (s === "") return "";
  const iso = s.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) {
    if (ISO_DATE.safeParse(iso[0]).success) {
      if (iso[0] !== s) {
        issues.push(
          warn(
            "INVALID_DATE",
            path,
            `${ctx}: ngày "${s}" chứa text ngoài phần ISO — giữ "${iso[0]}", phần còn lại bị lược, kiểm tra lại.`,
          ),
        );
      }
      return iso[0];
    }
    issues.push(
      warn(
        "INVALID_DATE",
        path,
        `${ctx}: ngày "${iso[0]}" trong "${s}" không phải ngày lịch thật — để trống.`,
      ),
    );
    return "";
  }
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const candidate = `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
    if (ISO_DATE.safeParse(candidate).success) return candidate;
  }
  issues.push(
    warn(
      "INVALID_DATE",
      path,
      `${ctx}: không nhận diện được ngày "${s}" — để trống.`,
    ),
  );
  return "";
}

/**
 * Box→behavior name resolution (plan §2.2: "resolveNamedLink-style exact
 * match"). Exact trimmed-name hits only — no substring, no folding.
 * Returns the matched id and hit count; the caller decides the Issue.
 */
export function resolveNamedLink(
  name: string,
  rows: { id: string; name: string }[],
): { id: string | null; hits: number } {
  const n = name.trim();
  const hits = rows.filter((r) => r.name.trim() === n);
  return { id: hits.length === 1 ? hits[0]!.id : null, hits: hits.length };
}

/* ------------------------------------------------------------------ *
 *  parseMarkdown                                                       *
 * ------------------------------------------------------------------ */

/**
 * Labels the exporter itself emits — recognized furniture, not content.
 * The `:**` colon is required so a line like `**Bối cảnh đẹp quá** foo`
 * (bold text, no label) still counts as leftover content.
 */
const KNOWN_LABEL_RE =
  /^\*\*(?:Bối cảnh|Solution Direction|Logic chốt hướng|Rủi ro|Key Result|Người lập|Canvas Stage|Build Mode|Schema Version|Last Updated|Migration Status)[^:\n]*:\*\*/i;

/**
 * Non-empty, unconsumed lines → warnings (loss-aware). Inside sections,
 * an unconsumed known-label line means a *duplicate* label — the first
 * occurrence was already imported, so it gets its own code. In the
 * document preamble (`exemptKnownLabels`), the meta/`Người lập` lines are
 * legitimate furniture and stay exempt.
 */
function warnLeftover(
  lines: string[],
  consumed: Set<number>,
  path: string,
  issues: Issue[],
  opts: { exemptKnownLabels?: boolean } = {},
): void {
  const rest = lines
    .map((l, i) => ({ l: l.trim(), i }))
    .filter(({ l, i }) => l !== "" && !consumed.has(i));
  const flagged = opts.exemptKnownLabels
    ? rest.filter(({ l }) => !KNOWN_LABEL_RE.test(l))
    : rest;
  if (flagged.length === 0) return;
  const dupLabels = flagged.filter(({ l }) => KNOWN_LABEL_RE.test(l));
  const other = flagged.filter(({ l }) => !KNOWN_LABEL_RE.test(l));
  if (dupLabels.length > 0) {
    issues.push(
      warn(
        "DUPLICATE_LABEL",
        path,
        `${dupLabels.length} dòng nhãn lặp lại (bắt đầu: "${dupLabels[0]!.l.slice(0, 80)}") — chỉ nhãn đầu tiên được import, dòng này bị lược, kiểm tra tay.`,
      ),
    );
  }
  if (other.length > 0) {
    issues.push(
      warn(
        "UNPARSED_CONTENT",
        path,
        `${other.length} dòng không thuộc khung canvas, không import — bắt đầu: "${other[0]!.l.slice(0, 80)}". Chép tay nếu cần.`,
      ),
    );
  }
}

/**
 * Parse a canvas Markdown document. Always returns a report; `body` is
 * null only when the text is not a canvas at all or the assembled body
 * somehow fails CanvasBodySchema (final gate — same contract as
 * fromLegacy).
 */
export function parseMarkdown(text: string): MarkdownImport {
  const issues: Issue[] = [];
  const md = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = md.split("\n");

  // ---- heading scan: title + "## 1..6" sections + "###" subs of §6 ----
  let title: string | null = null;
  const sec: Record<string, string[]> = {};
  const sub: Record<string, string[]> = {};
  const stray: string[] = [];
  let cur: string | null = null;
  let curSub: string | null = null;
  for (const line of lines) {
    const h1 = line.match(
      /^#\s+PERFORMANCE\s+ARCHITECTURE\s+CANVAS\s*[—–-]+\s*(.+?)\s*$/i,
    );
    if (h1) {
      if (title === null) {
        title = h1[1]!;
      } else {
        issues.push(
          warn(
            "UNKNOWN_SECTION",
            "document",
            `Dòng tiêu đề canvas lặp lại "${line.trim().slice(0, 80)}" — bỏ qua.`,
          ),
        );
      }
      continue;
    }
    const h2 = line.match(/^##(?!#)\s*(.+?)\s*$/);
    if (h2) {
      const num = h2[1]!.match(/^([1-6])(?:[\.．:]|\s|$)/);
      if (num) {
        cur = num[1]!;
        curSub = null;
        sec[cur] ??= [];
      } else {
        issues.push(
          warn(
            "UNKNOWN_SECTION",
            "document",
            `Mục "## ${h2[1]}" không thuộc khung canvas 1–6 — nội dung mục này không import.`,
          ),
        );
        cur = null;
        curSub = null;
      }
      continue;
    }
    const h3 = line.match(/^###\s*(.+?)\s*$/);
    if (h3) {
      if (cur === "6") {
        const t = h3[1]!.toLowerCase();
        curSub = /observed/.test(t)
          ? "observed"
          : /review|lịch/.test(t)
            ? "reviews"
            : /measurement|plan/.test(t)
              ? "plan"
              : null;
        if (curSub) {
          sub[curSub] ??= [];
        } else {
          issues.push(
            warn(
              "UNKNOWN_SUBSECTION",
              "section.6",
              `Mục con "### ${h3[1]}" không nhận diện được (Measurement Plan / Observed Evidence / Lịch Review) — nội dung không import.`,
            ),
          );
        }
      } else {
        issues.push(
          warn(
            "UNKNOWN_SUBSECTION",
            cur ? `section.${cur}` : "document",
            `Mục con "### ${h3[1]}" nằm ngoài mục 6 — nội dung không import.`,
          ),
        );
      }
      continue;
    }
    if (/^#\s/.test(line)) {
      issues.push(
        warn(
          "UNKNOWN_SECTION",
          "document",
          `Heading "${line.trim().slice(0, 80)}" không phải tiêu đề canvas — bỏ qua.`,
        ),
      );
      continue;
    }
    if (cur === "6" && curSub) sub[curSub]!.push(line);
    else if (cur) sec[cur]!.push(line);
    else stray.push(line);
  }

  if (title === null && Object.keys(sec).length === 0) {
    return {
      body: null,
      issues: [
        err(
          "NOT_A_CANVAS",
          "document",
          "Không nhận diện được canvas trong nội dung — cần tiêu đề “# PERFORMANCE ARCHITECTURE CANVAS — …” hoặc các mục “## 1.”…“## 6.”. Dùng JSON (sao lưu) nếu đây là bản xuất JSON.",
        ),
      ],
    };
  }
  if (title === null) {
    issues.push(
      warn(
        "MISSING_TITLE",
        "meta.title",
        "Không tìm thấy dòng tiêu đề “# PERFORMANCE ARCHITECTURE CANVAS — …” — meta.title để trống.",
      ),
    );
  }
  for (const n of ["1", "2", "3", "4", "5", "6"]) {
    if (!sec[n]) {
      issues.push(
        warn(
          "MISSING_SECTION",
          `section.${n}`,
          `Thiếu mục “## ${n}.” — phần này để trống, điền tay lại.`,
        ),
      );
    }
  }
  warnLeftover(stray, new Set(), "document", issues, {
    exemptKnownLabels: true,
  });

  // ---- metadata (recognized labels; never imported into priv fields) --
  // Meta labels only count in the preamble (before `## 1.`) — a
  // "**Canvas Stage:** X" line inside a section is content, not metadata.
  const metaText = stray.join("\n");
  const grabMeta = (label: string): string | null => {
    const m = metaText.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*([^·\\n*]*)`));
    return m === null ? null : normalizeText(m[1]!);
  };
  const stageRaw = grabMeta("Canvas Stage");
  const modeRaw = grabMeta("Build Mode");
  const updatedRaw = grabMeta("Last Updated");
  const schemaRaw = grabMeta("Schema Version");
  const migRaw = grabMeta("Migration Status");
  if (schemaRaw !== null && schemaRaw !== "" && schemaRaw !== CANVAS_BUSINESS_SCHEMA) {
    issues.push(
      warn(
        "SCHEMA_VERSION_MISMATCH",
        "meta.schema",
        `Tài liệu ghi Schema Version "${schemaRaw}" — bản import luôn theo schema ${CANVAS_BUSINESS_SCHEMA}, kiểm tra lại.`,
      ),
    );
  }
  if (migRaw !== null && /migrated/i.test(migRaw)) {
    issues.push(
      warn(
        "SCHEMA_VERSION_MISMATCH",
        "meta.schema",
        "Canvas gốc có Migration Status “Migrated…” — bản import lưu ở dạng Native v3.",
      ),
    );
  }
  const meta: CanvasBody["meta"] = {
    title: title === null ? "" : normalizeText(title),
    owner: normalizeText(grabMeta("Người lập") ?? ""),
    stage: mdEnumReq(stageRaw ?? "", CANVAS_STAGES, "DRAFT", "Canvas Stage", "meta.stage", issues),
    mode: mdEnumReq(modeRaw ?? "", BUILD_MODES, "GUIDED", "Build Mode", "meta.mode", issues),
    updated: "",
    schema: CANVAS_BUSINESS_SCHEMA,
  };
  if (updatedRaw === null || updatedRaw === "") {
    issues.push(
      warn(
        "MISSING_META",
        "meta.updated",
        "Không tìm thấy “Last Updated” — meta.updated để trống.",
      ),
    );
  } else {
    meta.updated = mdDate(updatedRaw, "Last Updated", "meta.updated", issues);
  }

  // ---- §1 GOAL --------------------------------------------------------
  const consumed1 = new Set<number>();
  const L1 = sec["1"] ?? [];
  const ctxHit = grabLabeled(L1, /^\*\*Bối cảnh[^:]*:\*\*\s*(.*)$/i);
  if (ctxHit) {
    for (let i = ctxHit.span[0]; i <= ctxHit.span[1]; i++) consumed1.add(i);
  }
  const stmtLines: string[] = [];
  {
    let started = false;
    for (let i = 0; i < L1.length; i++) {
      const t = L1[i]!.trim();
      if (!t) {
        if (started) break;
        continue;
      }
      if (t.startsWith("|") || t.startsWith("**") || t.startsWith("#")) {
        if (started) break;
        continue;
      }
      started = true;
      consumed1.add(i);
      stmtLines.push(t);
    }
  }
  const goal: CanvasBody["goal"] = {
    statement: normalizeText(stmtLines.join("\n")),
    context: normalizeText(ctxHit?.value ?? ""),
  };
  warnLeftover(L1, consumed1, "section.1", issues);

  // ---- §2 KEY RESULT + CRITICAL OUTPUTS -------------------------------
  let kr: CanvasBody["kr"] = { metric: "", current: "", target: "", deadline: "", cs: "" };
  let krSeen = false;
  const outputs: CanvasBody["outputs"] = [];
  {
    const L2 = sec["2"] ?? [];
    const consumed2 = new Set<number>();
    const tables = mdTablesIn(L2);
    const t = tables.find((tb) => tb.headers.length >= 4);
    if (t) {
      for (let i = t.span[0]; i <= t.span[1]; i++) consumed2.add(i);
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 6, "Bước 2", `section.2.row.${idx}`, issues);
        const kind = cleanCell(r[1]!);
        if (/key\s*result/i.test(kind)) {
          if (krSeen) {
            issues.push(
              warn(
                "DUPLICATE_KEY_RESULT",
                "kr",
                `Bước 2: nhiều hơn một dòng “Key Result” — giữ dòng đầu, dòng "${cleanCell(r[0]!)}" bị lược, kiểm tra lại.`,
              ),
            );
            return;
          }
          krSeen = true;
          kr = {
            metric: cleanCell(r[0]!),
            current: cleanCell(r[2]!),
            target: cleanCell(r[3]!),
            // free text in the editor — preserved verbatim, never normalized
            deadline: cleanCell(r[4]!),
            cs: cleanCell(r[5]!),
          };
        } else {
          if (!/critical|output/i.test(kind)) {
            issues.push(
              warn(
                "UNKNOWN_ROW_TYPE",
                `outputs.${outputs.length}`,
                `Bước 2, dòng ${idx + 1}: cột Loại "${kind}" không phải “Key Result”/“Critical Output” — giữ dòng như Critical Output, kiểm tra lại.`,
              ),
            );
          }
          outputs.push({
            id: newId(),
            name: cleanCell(r[0]!),
            current: cleanCell(r[2]!),
            target: cleanCell(r[3]!),
            deadline: cleanCell(r[4]!),
            cs: cleanCell(r[5]!),
          });
        }
      });
      if (!krSeen) {
        issues.push(
          warn(
            "MISSING_KEY_RESULT",
            "kr",
            "Bước 2: không thấy dòng “Key Result” trong bảng — kr để trống.",
          ),
        );
      }
      if (outputs.length > 3) {
        const dropped = outputs.slice(3).map((o) => o.name);
        issues.push(
          warn(
            "LIST_TRUNCATED",
            "outputs",
            `Bước 2: ${outputs.length} Critical Outputs vượt giới hạn schema (tối đa 3) — giữ 3 dòng đầu, bị lược: ${dropped.join(" | ").slice(0, 160)}.`,
          ),
        );
        outputs.length = 3;
      }
    } else if (sec["2"]) {
      issues.push(
        warn(
          "MISSING_TABLE",
          "section.2",
          "Bước 2: không tìm thấy bảng Key Result / Critical Outputs — phần này để trống.",
        ),
      );
    }
    // The decorative "**Key Result:** …" line the exporter emits above the
    // table is format furniture — consume that one line so it isn't
    // flagged. Continuation lines under it are user content → leftover.
    const krDeco = grabLabeled(L2, /^\*\*Key Result:\*\*\s*(.*)$/i);
    if (krDeco) consumed2.add(krDeco.span[0]);
    warnLeftover(L2, consumed2, "section.2", issues);
  }

  // ---- §3 SOLUTION + BEHAVIORS ----------------------------------------
  const dirHit = grabLabeled(sec["3"] ?? [], /^\*\*Solution Direction:\*\*\s*(.*)$/i);
  const logicHit = grabLabeled(sec["3"] ?? [], /^\*\*Logic chốt hướng[^:]*:\*\*\s*(.*)$/i);
  const solution: CanvasBody["solution"] = {
    direction: normalizeText(dirHit?.value ?? ""),
    logic: normalizeText(logicHit?.value ?? ""),
  };
  const behaviors: CanvasBody["behaviors"] = [];
  {
    const L3 = sec["3"] ?? [];
    const consumed3 = new Set<number>();
    for (const hit of [dirHit, logicHit]) {
      if (hit) for (let i = hit.span[0]; i <= hit.span[1]; i++) consumed3.add(i);
    }
    const t = mdTablesIn(L3).find((tb) => tb.headers.length >= 5);
    if (t) {
      for (let i = t.span[0]; i <= t.span[1]; i++) consumed3.add(i);
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 6, "Bước 3", `behaviors.${idx}`, issues);
        behaviors.push({
          id: newId(),
          actor: cleanCell(r[0]!),
          behavior: cleanCell(r[1]!),
          context: cleanCell(r[2]!),
          outputs: cleanCell(r[3]!),
          signal: cleanCell(r[4]!),
          freq: cleanCell(r[5]!),
        });
      });
      if (behaviors.length > 5) {
        const dropped = behaviors.slice(5).map((b) => b.behavior);
        issues.push(
          warn(
            "LIST_TRUNCATED",
            "behaviors",
            `Bước 3: ${behaviors.length} Lever Behaviors vượt giới hạn schema (tối đa 5) — giữ 5 dòng đầu, bị lược: ${dropped.join(" | ").slice(0, 160)}.`,
          ),
        );
        behaviors.length = 5;
      }
    } else if (sec["3"]) {
      issues.push(
        warn(
          "MISSING_TABLE",
          "behaviors",
          "Bước 3: không tìm thấy bảng Lever Behaviors — phần này để trống.",
        ),
      );
    }
    warnLeftover(L3, consumed3, "section.3", issues);
  }

  // ---- §4 CONDITIONS | 6 BOXES ----------------------------------------
  const nameRows = behaviors.map((b) => ({ id: b.id, name: b.behavior }));
  const boxCells = new Map<number, string[]>(); // canonical slot → row cells
  {
    const L4 = sec["4"] ?? [];
    const consumed4 = new Set<number>();
    const t = mdTablesIn(L4).find((tb) => tb.headers.length >= 6);
    if (t) {
      for (let i = t.span[0]; i <= t.span[1]; i++) consumed4.add(i);
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 8, "Bước 4", `section.4.row.${idx}`, issues);
        const cell = cleanCell(r[0]!);
        const lower = cell.toLowerCase();
        let slot = SIX_BOXES.findIndex((b) => b.toLowerCase() === lower);
        if (slot < 0 && lower !== "") {
          // Legacy fallback: a cell containing one canonical vn/en name.
          // More than one hit is ambiguous — keep the first and say so.
          const hits = SIX_BOXES.map((b, i) => ({ b, i })).filter(({ b }) => {
            const [vn, en] = b.split(" | ").map((x) => x.toLowerCase());
            return lower.includes(vn!) || lower.includes(en!);
          });
          if (hits.length > 1) {
            issues.push(
              warn(
                "AMBIGUOUS_BOX",
                `section.4.row.${idx}`,
                `Bước 4, dòng ${idx + 1}: "${cell}" khớp ${hits.length} box chuẩn (${hits.map((h) => `"${h.b.split(" | ")[0]}"`).join(", ")}) — gắn vào "${hits[0]!.b.split(" | ")[0]}", kiểm tra lại.`,
              ),
            );
          }
          slot = hits.length ? hits[0]!.i : -1;
        }
        if (slot < 0) {
          issues.push(
            warn(
              "UNRECOGNIZED_BOX",
              `section.4.row.${idx}`,
              `Bước 4, dòng ${idx + 1}: không nhận diện được box "${cell}" — dòng này không gắn vào box chuẩn nào, kiểm tra tay.`,
            ),
          );
          return;
        }
        if (boxCells.has(slot)) {
          issues.push(
            warn(
              "DUPLICATE_BOX",
              `boxes.${slot}`,
              `Bước 4: box "${SIX_BOXES[slot]!.split(" | ")[0]}" xuất hiện hai lần — giữ dòng đầu, dòng ${idx + 1} bị lược.`,
            ),
          );
          return;
        }
        boxCells.set(slot, r);
      });
    } else if (sec["4"]) {
      issues.push(
        warn(
          "MISSING_TABLE",
          "boxes",
          "Bước 4: không tìm thấy bảng 6 Boxes — sáu box để trống.",
        ),
      );
    }
    warnLeftover(L4, consumed4, "section.4", issues);
  }
  const boxes: CanvasBody["boxes"] = SIX_BOXES.map((box, i) => {
    const r = boxCells.get(i);
    if (!r) {
      if (boxCells.size > 0 || sec["4"]) {
        issues.push(
          warn(
            "MISSING_BOX",
            `boxes.${i}`,
            `Bước 4: thiếu dòng cho box "${box.split(" | ")[0]}" — tạo dòng trống.`,
          ),
        );
      }
      return {
        id: newId(),
        box,
        condition: "",
        evidence: "",
        gap: "" as const,
        priority: "" as const,
        behavior_id: null,
        action: "",
        assignee_label: "",
      };
    }
    const ctx = `Bước 4 ("${box.split(" | ")[0]}")`;
    const behName = cleanCell(r[5]!);
    let behaviorId: string | null = null;
    if (behName !== "") {
      // Real behavior names win over the "Cần xác nhận" undecided marker —
      // a behavior literally named "Cần xác nhận" is still linkable, but
      // the collision is flagged since the cell is genuinely ambiguous.
      const hit = resolveNamedLink(behName, nameRows);
      if (hit.hits > 1) {
        issues.push(
          err(
            "AMBIGUOUS_OR_MISSING_REFERENCE",
            `boxes.${i}.behavior_id`,
            `${ctx}: hành vi "${behName}" khớp ${hit.hits} Lever Behaviors — không chọn được, để trống (Cần xác nhận), chọn lại trong form.`,
          ),
        );
      } else if (hit.id) {
        behaviorId = hit.id;
        if (behName === "Cần xác nhận") {
          issues.push(
            warn(
              "MARKER_COLLISION",
              `boxes.${i}.behavior_id`,
              `${ctx}: "${behName}" vừa là tên Lever Behavior vừa là nhãn "chưa xác nhận" — đã liên kết theo tên; nếu ý là chưa xác nhận, để ô trống.`,
            ),
          );
        }
      } else if (behName !== "Cần xác nhận") {
        issues.push(
          err(
            "AMBIGUOUS_OR_MISSING_REFERENCE",
            `boxes.${i}.behavior_id`,
            `${ctx}: hành vi "${behName}" không khớp đúng-tên Lever Behavior nào — để trống (Cần xác nhận), chọn lại trong form.`,
          ),
        );
      }
      // behName === "Cần xác nhận" with no behavior of that name → the
      // undecided marker → null, no issue.
    }
    return {
      id: newId(),
      box,
      condition: cleanCell(r[1]!),
      evidence: cleanCell(r[2]!),
      gap: mdEnumOpt(r[3]!, GAP_LEVELS, `${ctx} (Khoảng cách)`, `boxes.${i}.gap`, issues),
      priority: mdEnumOpt(r[4]!, PRIORITY_LEVELS, `${ctx} (Ưu tiên)`, `boxes.${i}.priority`, issues),
      behavior_id: behaviorId,
      action: cleanCell(r[6]!),
      assignee_label: cleanCell(r[7]!),
    };
  });

  // ---- §5 ACTION EXPERIMENT + risks ------------------------------------
  const actions: CanvasBody["actions"] = [];
  let risks = "";
  {
    const L5 = sec["5"] ?? [];
    const consumed5 = new Set<number>();
    const t = mdTablesIn(L5).find((tb) => tb.headers.length >= 6);
    if (t) {
      for (let i = t.span[0]; i <= t.span[1]; i++) consumed5.add(i);
      t.rows.forEach((r0, idx) => {
        const r = fitRow(r0, 8, "Bước 5", `actions.${idx}`, issues);
        actions.push({
          id: newId(),
          action: cleanCell(r[0]!),
          start: mdDate(r[1]!, "Bước 5 (Start)", `actions.${idx}.start`, issues),
          deadline: mdDate(r[2]!, "Bước 5 (Deadline)", `actions.${idx}.deadline`, issues),
          assignee_label: cleanCell(r[3]!),
          supporter_label: cleanCell(r[4]!),
          criteria: cleanCell(r[5]!),
          status: mdEnumReq(
            r[6]!,
            ACTION_STATUSES,
            "Chưa bắt đầu",
            "Bước 5 (Trạng thái)",
            `actions.${idx}.status`,
            issues,
          ),
          risk: cleanCell(r[7]!),
        });
      });
    } else if (sec["5"]) {
      issues.push(
        warn(
          "MISSING_TABLE",
          "actions",
          "Bước 5: không tìm thấy bảng Action Experiment — phần này để trống.",
        ),
      );
    }
    const riskLines: string[] = [];
    let riskWarned = false;
    for (let i = 0; i < L5.length; i++) {
      const tl = L5[i]!.trim();
      const riskLabel = tl.match(/^\*\*Rủi ro[^:\n]*:\*\*\s*(.*)$/i);
      if (!riskLabel) continue;
      consumed5.add(i);
      // Text after the `:**` is risk content on the label line itself —
      // capture it, never drop it.
      const inline = riskLabel[1]!.trim();
      if (inline !== "") riskLines.push(normalizeText(inline));
      for (let j = i + 1; j < L5.length; j++) {
        const tj = L5[j]!.trim();
        if (tj === "") {
          consumed5.add(j);
          continue;
        }
        if (tj.startsWith("|") || tj.startsWith("**") || tj.startsWith("#")) break;
        consumed5.add(j);
        if (tj.startsWith("- ") || tj.startsWith("• ")) {
          riskLines.push(normalizeText(tj.replace(/^[-•]\s*/, "")));
        } else {
          if (!riskWarned) {
            issues.push(
              warn(
                "RISKS_FORMAT",
                "risks",
                "Bước 5: có dòng rủi ro không bắt đầu bằng “- ” — vẫn giữ nguyên văn vào risks, kiểm tra lại.",
              ),
            );
            riskWarned = true;
          }
          riskLines.push(normalizeText(tj));
        }
      }
      break;
    }
    risks = riskLines.join("\n");
    warnLeftover(L5, consumed5, "section.5", issues);
  }

  // ---- §6 FOLLOW-UP EVIDENCE — 3 sub tables ----------------------------
  const grabTable = (
    name: "plan" | "observed" | "reviews",
    k: number,
  ): { rows: string[][] } => {
    const lines = sub[name] ?? [];
    const tables = mdTablesIn(lines);
    const t = tables.find((tb) => tb.headers.length >= Math.min(k, 6)) ?? tables[0];
    const consumed = new Set<number>();
    if (t) for (let i = t.span[0]; i <= t.span[1]; i++) consumed.add(i);
    warnLeftover(lines, consumed, `section.6.${name}`, issues);
    if (!t) return { rows: [] };
    return {
      rows: t.rows.map((r, idx) =>
        fitRow(r, k, `Bước 6 (${name})`, `${name}.${idx}`, issues),
      ),
    };
  };

  const dropBlank = <T extends Record<string, unknown>>(row: T, keys: (keyof T)[]): T | null =>
    keys.every((k) => String(row[k] ?? "").trim() === "") ? null : row;

  let plan: CanvasBody["plan"] = [];
  let observed: CanvasBody["observed"] = [];
  let reviews: CanvasBody["reviews"] = [];
  if (sec["6"]) {
    for (const name of ["plan", "observed", "reviews"] as const) {
      if (!sub[name]) {
        issues.push(
          warn(
            "MISSING_SUBSECTION",
            `section.6.${name}`,
            `Bước 6: thiếu mục con "${name === "plan" ? "Measurement Plan" : name === "observed" ? "Observed Evidence" : "Lịch Review"}" — phần này để trống.`,
          ),
        );
      }
    }
    // Lines in §6 that never fell under a recognized ### subsection
    // (stray prose or tables placed directly under "## 6") — not imported.
    warnLeftover(sec["6"]!, new Set(), "section.6", issues);

    plan = grabTable("plan", 8).rows.flatMap((r, idx) => {
      const row = {
        id: newId(),
        date: mdDate(r[0]!, "Measurement Plan (ngày)", `plan.${idx}.date`, issues),
        layer: mdEnumOpt(r[1]!, EVIDENCE_LAYERS, "Measurement Plan (tầng)", `plan.${idx}.layer`, issues),
        metric: cleanCell(r[2]!),
        baseline: cleanCell(r[3]!),
        target: cleanCell(r[4]!),
        source: cleanCell(r[5]!),
        collector: cleanCell(r[6]!),
        verifier: cleanCell(r[7]!),
      };
      const kept = dropBlank(row, ["date", "layer", "metric", "baseline", "target", "source", "collector", "verifier"]);
      return kept ? [kept] : [];
    });

    observed = grabTable("observed", 8).rows.flatMap((r, idx) => {
      const row = {
        id: newId(),
        date: mdDate(r[0]!, "Observed Evidence (ngày)", `observed.${idx}.date`, issues),
        layer: mdEnumOpt(r[1]!, EVIDENCE_LAYERS, "Observed Evidence (tầng)", `observed.${idx}.layer`, issues),
        value: cleanCell(r[2]!),
        source: cleanCell(r[3]!),
        confidence: mdEnumOpt(r[4]!, CONFIDENCE_LEVELS, "Observed Evidence (độ tin cậy)", `observed.${idx}.confidence`, issues),
        learning: cleanCell(r[5]!),
        decision: mdEnumOpt(r[6]!, REVIEW_DECISIONS, "Observed Evidence (quyết định)", `observed.${idx}.decision`, issues),
        verifier: cleanCell(r[7]!),
      };
      const kept = dropBlank(row, ["date", "layer", "value", "source", "confidence", "learning", "decision", "verifier"]);
      return kept ? [kept] : [];
    });

    reviews = grabTable("reviews", 9).rows.flatMap((r, idx) => {
      const row = {
        id: newId(),
        checkpoint: cleanCell(r[0]!),
        date: mdDate(r[1]!, "Lịch Review (ngày)", `reviews.${idx}.date`, issues),
        behavior_evidence: cleanCell(r[2]!),
        output_evidence: cleanCell(r[3]!),
        result_evidence: cleanCell(r[4]!),
        works: cleanCell(r[5]!),
        not_works: cleanCell(r[6]!),
        learning: cleanCell(r[7]!),
        verifier: cleanCell(r[8]!),
      };
      const kept = dropBlank(row, ["checkpoint", "date", "behavior_evidence", "output_evidence", "result_evidence", "works", "not_works", "learning", "verifier"]);
      return kept ? [kept] : [];
    });
  }

  const body: CanvasBody = {
    schema_version: CANVAS_PAYLOAD_VERSION,
    meta,
    goal,
    kr,
    outputs,
    solution,
    behaviors,
    boxes,
    actions,
    risks,
    plan,
    observed,
    reviews,
  };

  // Belt-and-suspenders (same final gate as fromLegacy): the assembled
  // body must satisfy CanvasBodySchema — otherwise report schema issues
  // as blocking errors and refuse the body.
  const gate = CanvasBodySchema.safeParse(body);
  if (!gate.success) {
    for (const zi of gate.error.issues.slice(0, 12)) {
      issues.push(
        err(
          "schema",
          zi.path.join(".") || "(root)",
          `Body dựng xong không đạt CanvasBodySchema: ${zi.message}`,
        ),
      );
    }
    return { body: null, issues };
  }

  return { body, issues };
}

/* ------------------------------------------------------------------ *
 *  toMarkdown                                                          *
 * ------------------------------------------------------------------ */

/**
 * Serialize a canonical body to the Markdown canvas format. Emits content
 * only — row ids and server fields never appear. Warnings flag everything
 * the format cannot carry back on import (extension fields, placeholder
 * collisions, markup-hostile characters in prose fields).
 */
export function toMarkdown(body: CanvasBody): MarkdownExport {
  const warnings: string[] = [];
  const m = body.meta;
  const L: string[] = [];

  const lossy = (cond: boolean, msg: string): void => {
    if (cond) warnings.push(msg);
  };
  /**
   * Any value equal to a placeholder token reimports as "" — warn so the
   * loss is never silent (applies to cells AND prose/meta fields alike).
   */
  const checkPlaceholder = (v: string, ctx: string): void => {
    if (PLACEHOLDER_RE.test(v.trim())) {
      warnings.push(
        `${ctx}: giá trị "${v.trim()}" trùng placeholder (TBD/(chưa điền)/—) — import lại sẽ thành trống, hãy diễn đạt khác.`,
      );
    }
  };
  /**
   * Labeled one-line prose (`**Label:** value`) can't hold a newline —
   * reimport joins continuation lines with a space. `goal.statement` and
   * `risks` are multi-line fields and do NOT go through this.
   */
  const prose = (v: string, ctx: string): string => {
    if (/\r|\n/.test(v)) {
      warnings.push(
        `${ctx}: giá trị chứa xuống dòng — nhãn Markdown chỉ giữ một dòng; phần xuống dòng sẽ nhập lại thành khoảng trắng.`,
      );
    }
    checkPlaceholder(v, ctx);
    return v;
  };

  const collisionCells: string[] = [];
  const cell = (v: string, ctx: string): string => {
    const { cell: c, placeholderCollision } = mdCell(v);
    if (placeholderCollision) collisionCells.push(`${ctx}: "${v.trim()}"`);
    return c;
  };
  const table = (headers: string[], rows: string[][], ctx: string): string => {
    const out = [
      `| ${headers.join(" | ")} |`,
      `|${headers.map(() => "---").join("|")}|`,
    ];
    rows.forEach((r, i) => {
      out.push(
        `| ${r.map((v, j) => cell(v, `${ctx} dòng ${i + 1} cột "${headers[j]}"`)).join(" | ")} |`,
      );
    });
    return out.join("\n");
  };
  const hasContent = (r: string[]): boolean => r.some((v) => v.trim() !== "");

  // ---- extension fields Markdown cannot carry -------------------------
  const extDetails: string[] = [];
  body.observed.forEach((o, i) => {
    if (o.measurement) {
      extDetails.push(
        `observed.${i}.measurement (metricId ${o.measurement.metricId}, rev ${o.measurement.definitionRevision})`,
      );
    }
  });
  body.boxes.forEach((b, i) => {
    if (b.assignee_user_id) extDetails.push(`boxes.${i}.assignee_user_id`);
  });
  body.actions.forEach((a, i) => {
    if (a.assignee_user_id) extDetails.push(`actions.${i}.assignee_user_id`);
  });
  if (extDetails.length) {
    warnings.push("JSON_REQUIRED_FOR_EXTENSIONS");
    warnings.push(
      `Markdown không mang được: ${extDetails.join("; ")} — dùng JSON export để giữ trường mở rộng/id.`,
    );
  }

  // ---- header ---------------------------------------------------------
  const title = m.title.trim() || "(chưa đặt tên)";
  lossy(
    /\r|\n/.test(title),
    "meta.title chứa xuống dòng — tiêu đề Markdown chỉ một dòng, đã nối bằng khoảng trắng.",
  );
  checkPlaceholder(m.title, "meta.title");
  L.push(`# PERFORMANCE ARCHITECTURE CANVAS — ${title.replace(/\s*\r?\n\s*/g, " ")}`);
  L.push("");
  L.push(
    `**Canvas Stage:** ${m.stage} · **Build Mode:** ${m.mode} · **Schema Version:** ${CANVAS_BUSINESS_SCHEMA} · **Last Updated:** ${m.updated || ""} · **Migration Status:** Native v3`,
  );
  if (m.owner.trim()) {
    lossy(
      /[·*\r\n]/.test(m.owner),
      `meta.owner chứa ký tự "·" / "*" / xuống dòng — dòng meta chỉ đọc tới ký tự đó khi import, phần sau sẽ mất.`,
    );
    checkPlaceholder(m.owner, "meta.owner");
    L.push(`**Người lập:** ${m.owner.trim()}`);
  }
  L.push("");

  // ---- §1 --------------------------------------------------------------
  L.push("## 1. GOAL | MỤC TIÊU");
  L.push("");
  const stmt = body.goal.statement.trim();
  lossy(
    /\n\s*\n/.test(stmt) || stmt.split("\n").some((l) => /^[|#*]/.test(l.trim())),
    "goal.statement chứa đoạn trống hoặc dòng bắt đầu bằng |/#/* — import Markdown chỉ đọc đoạn đầu tiên, phần sau sẽ thành UNPARSED_CONTENT.",
  );
  checkPlaceholder(stmt, "goal.statement");
  L.push(stmt || "(chưa điền)");
  if (body.goal.context.trim()) {
    prose(body.goal.context.trim(), "goal.context");
    L.push("");
    L.push(`**Bối cảnh & phạm vi:** ${body.goal.context.trim()}`);
  }
  L.push("");

  // ---- §2 --------------------------------------------------------------
  L.push("## 2. KEY RESULT + CRITICAL OUTPUTS / CS");
  L.push("");
  if (body.kr.metric.trim() || body.kr.current || body.kr.target) {
    L.push(
      `**Key Result:** ${body.kr.metric.trim()} tăng/đạt từ **${body.kr.current || "?"}** (hiện tại) lên **${body.kr.target || "?"}** (mục tiêu), thời hạn **${body.kr.deadline || "?"}**.`,
    );
    L.push("");
  }
  L.push(
    table(
      ["Thành phần", "Loại", "Hiện tại", "Mục tiêu", "Thời hạn", "Tiêu chuẩn chất lượng (CS)"],
      [
        [body.kr.metric, "Key Result", body.kr.current, body.kr.target, body.kr.deadline, body.kr.cs],
        ...body.outputs
          .map((o) => [o.name, "Critical Output", o.current, o.target, o.deadline, o.cs])
          .filter(hasContent),
      ],
      "Bước 2",
    ),
  );
  L.push("");

  // ---- §3 --------------------------------------------------------------
  L.push("## 3. SOLUTION DIRECTION + LEVER BEHAVIORS");
  L.push("");
  prose(body.solution.direction.trim(), "solution.direction");
  L.push(`**Solution Direction:** ${body.solution.direction.trim() || "(chưa điền)"}`);
  if (body.solution.logic.trim()) {
    prose(body.solution.logic.trim(), "solution.logic");
    L.push("");
    L.push(`**Logic chốt hướng (kiểm chứng bằng bằng chứng):** ${body.solution.logic.trim()}`);
  }
  L.push("");
  L.push(
    table(
      ["Chủ thể", "Lever Behavior", "Bối cảnh", "Output tác động", "Dấu hiệu quan sát được", "Tần suất"],
      body.behaviors
        .map((b) => [b.actor, b.behavior, b.context, b.outputs, b.signal, b.freq])
        .filter(hasContent),
      "Bước 3",
    ),
  );
  L.push("");

  // ---- §4 --------------------------------------------------------------
  const cầnXácNhậnIsName = body.behaviors.some(
    (b) => b.behavior.trim() === "Cần xác nhận",
  );
  lossy(
    cầnXácNhậnIsName && body.boxes.some((b) => b.behavior_id === null),
    'Có Lever Behavior tên đúng "Cần xác nhận" — các box chưa liên kết sẽ xuất ô trống để tránh nhập nhầm với hành vi đó.',
  );
  L.push("## 4. CONDITIONS | 6 BOXES");
  L.push("");
  L.push(
    table(
      ["6 Boxes", "Điều kiện cần", "Hiện trạng / Bằng chứng", "Khoảng cách", "Ưu tiên", "Hành vi liên quan", "Hành động sơ bộ", "Người sở hữu"],
      body.boxes.map((b, i) => {
        let link = "";
        if (b.behavior_id === null) {
          link = cầnXácNhậnIsName ? "" : "Cần xác nhận";
        } else {
          const hit = body.behaviors.find((x) => x.id === b.behavior_id);
          if (hit) {
            link = hit.behavior;
            if (hit.behavior.trim() === "Cần xác nhận") {
              // The exported cell is indistinguishable from the undecided
              // marker — surface the collision (import resolves by name
              // and emits MARKER_COLLISION).
              warnings.push(
                `boxes.${i}.behavior_id: Lever Behavior trùng tên nhãn "Cần xác nhận" — ô liên kết trông giống trạng thái chưa xác nhận; nên đổi tên hành vi.`,
              );
            }
          } else {
            warnings.push(
              `boxes.${i}.behavior_id "${b.behavior_id}" không tồn tại trong behaviors[] — ô liên kết để trống, kiểm tra lại.`,
            );
          }
        }
        return [b.box, b.condition, b.evidence, b.gap, b.priority, link, b.action, b.assignee_label];
      }),
      "Bước 4",
    ),
  );
  L.push("");

  // ---- §5 --------------------------------------------------------------
  L.push("## 5. ACTION EXPERIMENT");
  L.push("");
  L.push(
    table(
      ["Action", "Start", "Deadline", "Owner", "Supporter", "Success Criteria", "Status", "Risk / Adjustment"],
      body.actions
        .map((a) => [a.action, a.start, a.deadline, a.assignee_label, a.supporter_label, a.criteria, a.status, a.risk])
        .filter(hasContent),
      "Bước 5",
    ),
  );
  if (body.risks.trim()) {
    const riskLines = body.risks.trim().split(/\n+/);
    lossy(
      /\n\s*\n/.test(body.risks.trim()),
      "risks chứa dòng trống — import Markdown gộp các bullet liên tiếp, dòng trống sẽ mất.",
    );
    riskLines.forEach((rl, i) => {
      const t = rl.trim();
      lossy(
        /^[|#*]/.test(t) && !/^[-•]\s/.test(t),
        `risks dòng ${i + 1} bắt đầu bằng "${t[0]}" — import sẽ ngắt khối rủi ro tại đây, phần sau mất.`,
      );
      checkPlaceholder(t.replace(/^[-•]\s*/, ""), `risks dòng ${i + 1}`);
    });
    L.push("");
    L.push("**Rủi ro / Giả định cần kiểm chứng:**");
    L.push("");
    riskLines.forEach((rl) => {
      const t = rl.trim();
      L.push(t.startsWith("-") || t.startsWith("•") ? t.replace(/^•/, "-") : `- ${t}`);
    });
  }
  L.push("");

  // ---- §6 --------------------------------------------------------------
  L.push("## 6. FOLLOW-UP EVIDENCE APPROPRIATE TO STAGE");
  L.push("");
  L.push("### Measurement Plan");
  L.push("");
  L.push(
    table(
      ["planned_date", "evidence_layer", "metric_or_criterion", "baseline", "target", "data_source", "collector", "verifier"],
      body.plan
        .map((p) => [p.date, p.layer, p.metric, p.baseline, p.target, p.source, p.collector, p.verifier])
        .filter(hasContent),
      "Measurement Plan",
    ),
  );
  L.push("");
  L.push("### Observed Evidence");
  L.push("");
  const obsRows = body.observed
    .map((o) => [o.date, o.layer, o.value, o.source, o.confidence, o.learning, o.decision, o.verifier])
    .filter(hasContent);
  L.push(
    table(
      ["observed_date", "evidence_layer", "value_or_evidence", "source_reference", "confidence", "learning", "decision", "verifier"],
      obsRows.length === 0 && m.stage === "DRAFT"
        ? [Array<string>(8).fill("TBD")]
        : obsRows,
      "Observed Evidence",
    ),
  );
  L.push("");
  L.push("### Lịch Review & bài học");
  L.push("");
  L.push(
    table(
      ["Mốc Review", "Ngày", "Behavior Evidence", "Output Evidence", "Result Evidence", "Điều hiệu quả", "Điều chưa hiệu quả", "Learning & Next Step", "Người xác nhận"],
      body.reviews
        .map((r) => [r.checkpoint, r.date, r.behavior_evidence, r.output_evidence, r.result_evidence, r.works, r.not_works, r.learning, r.verifier])
        .filter(hasContent),
      "Lịch Review",
    ),
  );
  L.push("");

  for (const c of collisionCells) {
    warnings.push(
      `Ô ${c} trùng placeholder (TBD/—) — Markdown import sẽ đọc ô này là trống; diễn đạt khác hoặc dùng JSON export.`,
    );
  }

  return { text: L.join("\n"), warnings };
}
