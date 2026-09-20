/**
 * Task 2.7 — XLSX export can never emit an executable formula.
 *
 * buildXlsx writes every cell as `t="inlineStr"` — user text starting
 * with =, +, -, @ or a leading quote-escape stays inert inside <is><t>.
 * The stored-zip output is scanned raw: a regression that introduced a
 * shared-string or formula cell path would surface here immediately.
 */
import { describe, expect, it } from "vitest";
import { blankBody, buildXlsx } from "../../web/canvas/model.js";
import type { CanvasBody } from "../../shared/canvas/schema.js";

const ATTACKS = [
  "=HYPERLINK(\"https://evil.example\",\"click\")",
  "=cmd|'/c calc'!A1",
  "+1+1",
  "@SUM(1,2)",
  "-2+3",
  "'=OR(1=1)",
];

async function sheetXml(body: CanvasBody) {
  const blob = buildXlsx(body);
  const buf = new Uint8Array(await blob.arrayBuffer());
  // Stored entries: sheet XML sits verbatim between its local header and
  // the central directory — decode the whole blob and slice it out.
  const all = new TextDecoder().decode(buf);
  const start = all.indexOf("<worksheet");
  const end = all.indexOf("</worksheet>");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return all.slice(start, end);
}

describe("buildXlsx formula safety (task 2.7)", () => {
  it("every cell is an inline string — attack strings stay inert text", async () => {
    const body = blankBody();
    body.meta.title = "=cmd|'/c calc'!A1";
    body.actions = ATTACKS.map((s, i) => ({
      id: `a${i}`,
      action: s,
      start: "",
      deadline: "",
      assignee_label: "X",
      supporter_label: "",
      criteria: "",
      status: "Đang thực hiện",
      risk: "",
      assignee_user_id: undefined,
    }));

    const xml = await sheetXml(body);
    // No formula elements anywhere in the sheet.
    expect(xml).not.toContain("<f>");
    expect(xml).not.toContain("<f ");
    // Every emitted cell is an inline string.
    expect(xml).not.toMatch(/<c [^>]*t="(?!inlineStr)/);
    // The payloads survive as escaped text content.
    for (const s of ATTACKS) {
      expect(xml).toContain(s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
    }
  });

  it("XML metacharacters in cell text are escaped", async () => {
    const body = blankBody();
    body.goal.statement = 'a<b>&"c"';
    const xml = await sheetXml(body);
    expect(xml).toContain("a&lt;b&gt;&amp;&quot;c&quot;");
    expect(xml).not.toContain('a<b>&"c"');
  });
});
