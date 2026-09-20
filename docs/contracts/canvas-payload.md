# Canvas payload contract (schema_version 1)

Canonical storage/API shape for a Performance Architecture Canvas body.
Module: `shared/canvas/` — pure TypeScript + zod, no server/client imports.

- `schema.ts` — `CanvasBodySchema`, `Measurement`, enums (`CANVAS_STAGES`,
  `BUILD_MODES`, `GAP_LEVELS`, `PRIORITY_LEVELS`, `ACTION_STATUSES`,
  `EVIDENCE_LAYERS`, `CONFIDENCE_LEVELS`, `REVIEW_DECISIONS`, `SIX_BOXES`),
  inferred type `CanvasBody`.
- `defaults.ts` — `blankCanvas(clock)`, `newId()`, blank row factories.
- `validation.ts` — `validateCanvas(body, "draft" | "publish"): Issue[]`.
- `legacy.ts` — `fromLegacy(raw): { body: CanvasBody | null, warnings: string[] }`.
- `markdown.ts` — `parseMarkdown(text): { body: CanvasBody | null, issues: Issue[] }`,
  `toMarkdown(body): { text: string, warnings: string[] }`,
  `resolveNamedLink(name, rows): { id, hits }`.

Fixtures: `tests/fixtures/canvas/legacy.json` (assets/data.js `CANVAS.tc2`
version `v2`, flattened with `id`/`personId`/`name`) and
`tests/fixtures/canvas/canonical.json` (the same snapshot in canonical form;
`fromLegacy(legacy.json)` reproduces it exactly modulo generated row ids).

## Versioning

- `schema_version: 1` — payload/storage version, technical, owned by this
  contract. Bump on breaking shape changes.
- `meta.schema: "3.0"` — business schema label ("Canvas schema 3.0"), shown in
  exports; independent of `schema_version` and of `version_no`.

## Shape

```text
CanvasBody {
  schema_version: 1
  meta     { title, owner, stage, mode, updated, schema }
  goal     { statement, context }
  kr       { metric, current, target, deadline, cs }          # no row id
  outputs  [≤3] { id, name, current, target, deadline, cs }
  solution { direction, logic }
  behaviors[≤5] { id, actor, behavior, context, outputs, signal, freq }
  boxes    [=6] { id, box∈SIX_BOXES, condition, evidence, gap, priority,
                  behavior_id|null, action, assignee_label,
                  assignee_user_id? }
  actions  []   { id, action, start, deadline, assignee_label,
                  supporter_label, criteria, status, risk,
                  assignee_user_id? }
  risks    string                                            # newline-joined
  plan     []   { id, date, layer, metric, baseline, target, source,
                  collector, verifier }
  observed []   { id, date, layer, value, source, confidence, learning,
                  decision, verifier, measurement? }
  reviews  []   { id, checkpoint, date, behavior_evidence, output_evidence,
                  result_evidence, works, not_works, learning, verifier }
}
```

Every object is `.strict()` — unknown keys are rejected at every level, so
privilege/server fields (`company_id`, `owner_user_id`, `canvas_id`, …) can
never ride in through a payload. All row `id`s are UUIDs.

Note: `boxes` is `.length(6)` at **schema** level — every stored body, draft
or published, carries exactly the six canonical box rows (blank ones while
undecided). Importers (Markdown round-trip in 2.2, editor in 2.5) must
always emit 6 rows; there is no "fewer boxes" draft state.

### Enums

| field | values | blankable |
|---|---|---|
| `meta.stage` | `DRAFT`, `PILOTING`, `VALIDATED` | no |
| `meta.mode` | `GUIDED`, `RAPID_DRAFT` | no |
| `boxes[].gap` | `Cao`, `Trung bình`, `Thấp` | yes (`""`) |
| `boxes[].priority` | `Cao`, `Trung bình`, `Thấp`, `Chưa xác định` | yes |
| `actions[].status` | `Chưa bắt đầu`, `Đang thực hiện`, `Hoàn thành`, `Tạm dừng`, `Cần hỗ trợ` | no (default `Chưa bắt đầu`) |
| `plan[].layer`, `observed[].layer` | `BEHAVIOR`, `OUTPUT`, `RESULT` | yes |
| `observed[].confidence` | `HIGH`, `MEDIUM`, `LOW` | yes |
| `observed[].decision` | `CONTINUE`, `ADJUST`, `STOP` | yes |
| `boxes[].box` | `SIX_BOXES` (bilingual canonical names, fixed order) | no |

### Typed vs free-text dates

`meta.updated`, `actions[].start/deadline`, `plan[].date`,
`observed[].date`, `reviews[].date` are ISO `YYYY-MM-DD` or `""`.
`kr.deadline` and `outputs[].deadline` are **free text** — legacy data uses
`31/12/2026` or `(chưa điền)`; import preserves them verbatim.

### References

`boxes[].behavior_id` links to `behaviors[].id` by UUID — never by name.
`null` means "Cần xác nhận" (unconfirmed): allowed in draft, rejected at
publish. `assignee_label`/`supporter_label` are free-text role labels;
`assignee_user_id` (optional UUID) is resolved server-side only, never
trusted from import.

### Measurement extension

`observed[].measurement` is optional and strict:

```ts
{
  metricId: uuid,
  definitionRevision: positive int,
  layer: "BEHAVIOR" | "OUTPUT" | "RESULT",
  date: iso date,
  value: finite number,
  unit: non-empty string,
  baseline: finite number,
  target: finite number,
}
```

`observed[].value` stays the verbatim text; `measurement` carries the typed
metric reference when one exists (drives dashboard series — spec §5.3).

## `validateCanvas(body, mode)` → `Issue[]`

`Issue = { severity: "error" | "warning", code, path, message }`.
`severity:"error"` blocks. Paths are dot-joined (`boxes.2.condition`).

### Both modes (structural)

- `schema` — body fails `CanvasBodySchema` (wrong types, bad enum values,
  unknown keys, list bound violations). Structural errors short-circuit:
  business checks only run on a schema-valid body.
- `duplicate_id` — a row id reused across `outputs/behaviors/boxes/actions/
  plan/observed/reviews` (dedup/diff rely on stable unique ids).
- `missing_reference` — `boxes[].behavior_id` points at no `behaviors[].id`.

### Publish only (`mode === "publish"`)

- `required` — non-empty content: `meta.title`, `goal.statement`,
  `kr.{metric,current,target,deadline,cs}`, `solution.{direction,logic}`,
  every output row field, `behaviors[].{actor,behavior}`,
  `boxes[].{condition,evidence,gap,priority}`,
  `actions[].{action,assignee_label,criteria}`,
  `plan[].{layer,metric}`, `reviews[].checkpoint`.
- `output_count` — `outputs` has ≥1 row (schema already caps at 3).
- `behavior_count` — `behaviors` has ≥2 rows (schema caps at 5).
- `box_set` — `boxes[].box` is not exactly the six canonical names.
- `action_count`, `plan_count`, `review_count` — ≥1 row each.
- `unconfirmed_behavior` — `boxes[].behavior_id === null`.
- `validated_requires_evidence` — `meta.stage === "VALIDATED"` and no
  observed row is *fully populated* (`date`, `value`, `source`, `learning`,
  `decision`, `verifier` all non-empty). A blank observed row is **not**
  evidence.

  Semantic edge (flagged for 2.2/2.5, not handled here): completeness is
  non-emptiness, not meaning — a row filled with placeholder text (`TBD`,
  `(chưa điền)`, `—`) in every field satisfies this check. The Markdown
  importer already strips `TBD`/`(chưa điền)` to `""` at parse time; keep
  that normalization on every write path that can carry placeholders.

Draft mode never blocks on business completeness — a fully blank
`blankCanvas()` is a valid draft.

## `fromLegacy(raw)` — demo snapshot adapter

Input: one legacy version record (`assets/data.js` `CANVAS.*.versions[]`
shape). Output: `{ body, warnings }`.

**Never fabricate:** `brief: true` records, or records with no content keys
at all, return `{ body: null, warnings }` — briefs are migration notes, not
snapshots.

### Field map

Complete map — identity (same-name) fields listed for completeness:

| legacy | canonical | notes |
|---|---|---|
| `name` | `meta.title` | canvas-level field, flattened onto the record |
| `owner` | `meta.owner` | |
| `stage` | `meta.stage` | invalid **or absent/blank** → warn + `DRAFT` |
| `mode` | `meta.mode` | invalid or absent/blank → warn + `GUIDED` |
| `date` | `meta.updated` | normalized to ISO (see rules) |
| `goal` / `context` | `goal.statement` / `goal.context` | verbatim |
| `direction` / `logic` | `solution.direction` / `solution.logic` | verbatim |
| `risks[]` | `risks` | joined with `"\n"` (a bare string passes through) |
| `kr.metric` | `kr.metric` | verbatim |
| `kr.cur` / `kr.tgt` / `kr.due` / `kr.cs` | `kr.current` / `kr.target` / `kr.deadline` / `kr.cs` | `due` verbatim free text |
| `outputs[].name` | `outputs[].name` | verbatim |
| `outputs[].cur` / `tgt` / `due` / `cs` | `current` / `target` / `deadline` / `cs` | `due` verbatim |
| `behaviors[].actor` | `behaviors[].actor` | verbatim |
| `behaviors[].beh` / `ctx` / `out` / `sign` / `freq` | `behavior` / `context` / `outputs` / `signal` / `freq` | |
| `boxes[].cond` / `ev` / `pri` / `act` / `own` | `condition` / `evidence` / `priority` / `action` / `assignee_label` | row order maps positionally onto `SIX_BOXES` |
| `boxes[].gap` | `gap` | enum; invalid → warn + `""` |
| `boxes[].beh` | `boxes[].behavior_id` | exact name match → `behaviors[].id`; unknown → `null` + warning |
| `actions[].act` / `own` / `sup` / `cri` / `risk` | `action` / `assignee_label` / `supporter_label` / `criteria` / `risk` | |
| `actions[].start` / `due` | `start` / `deadline` | ISO-normalized |
| `actions[].st` | `status` | invalid or absent/blank → warn + `Chưa bắt đầu` |
| `plan[].date` / `metric` | `date` / `metric` | date ISO-normalized; metric verbatim |
| `plan[].layer` | `layer` | enum; invalid → warn + `""` |
| `plan[].base` / `tgt` / `src` / `col` / `ver` | `baseline` / `target` / `source` / `collector` / `verifier` | |
| `observed[].date` / `layer` | `date` / `layer` | date ISO-normalized; layer enum (invalid → warn + `""`) |
| `observed[].val` / `src` / `conf` / `learn` / `dec` / `ver` | `value` / `source` / `confidence` / `learning` / `decision` / `verifier` | conf/dec enum (invalid → warn + `""`) |
| `reviews[].cp` / `date` / `ver` | `checkpoint` / `date` / `verifier` | date ISO-normalized |
| `reviews[].be` / `oe` / `re` / `ok` / `no` / `ln` | `behavior_evidence` / `output_evidence` / `result_evidence` / `works` / `not_works` / `learning` | absent review keys → `""` |
| `id`, `personId`, `v`, `week`, `change`, `brief` | — | server-owned bookkeeping/identity, recognized but not imported |

Rules:

- Dates (`date`, `actions[].start`/`due`, `*.date` on plan/observed/reviews):
  a bare ISO `YYYY-MM-DD` is kept after real-calendar validation; anchored
  `DD/MM/YYYY` normalizes to ISO (validated — `32/13/2026` warns + blanks);
  an ISO substring embedded in other text is kept **with a warning** naming
  field and value; impossible ISO (`2026-13-45`) or unrecognized text warns
  and blanks. `kr.due` / `outputs[].due` are free text — never normalized.
- Enums: exact match or warning + explicit fallback — including absent and
  blank required enums (`stage`, `mode`, `st`), which also warn. No silent
  defaults, no diacritic-folding guesses.
- Unknown keys — top-level or inside any row — always warn; privilege-shaped
  keys (`company_id`, `user_id`, …) are dropped with a warning, never
  imported.
- Schema bounds enforced at mapping: `outputs` >3 and `behaviors` >5 are
  truncated to the first rows with a warning (the publish bounds live in
  validation.ts; the schema `.max()` applies to every stored body).
- Missing content sections warn once and fall back to the blank-state shape
  (1 output, 2 behaviors, 6 blank boxes, 1 action, 3 plan rows, 1 observed
  row, 2 review checkpoints). An explicitly empty list (e.g.
  `observed: []`) is a real state and stays empty.
- Every mapped row gets a fresh UUID `id`; legacy records carry none.
- **Final gate:** the assembled body must pass `CanvasBodySchema`; if it
  ever fails, `fromLegacy` returns `body: null` plus warnings carrying the
  schema issues — the adapter never returns a body the schema would reject.
- The tc2 fixture maps with zero warnings and passes
  `validateCanvas(_, "publish")`.

## Markdown import/export (`shared/canvas/markdown.ts`)

The human-facing canvas document — same layout the legacy editor
(`canvas-online/index.html`, `buildMarkdown`/`parseCanvasMarkdown`) emits —
made loss-aware. `tests/fixtures/canvas/canonical.md` is the golden document:
`toMarkdown(canonical.json)` reproduces it byte-for-byte and
`parseMarkdown` rebuilds the body modulo regenerated row ids.

```ts
parseMarkdown(text: string): { body: CanvasBody | null, issues: Issue[] }
toMarkdown(body: CanvasBody): { text: string, warnings: string[] }
```

`body` is `null` only when the text is not a canvas at all (no
`# PERFORMANCE ARCHITECTURE CANVAS — …` title and no `## 1.`–`## 6.`
section → `NOT_A_CANVAS` error) or the assembled body fails the final
`CanvasBodySchema` gate (`schema` errors, same contract as `fromLegacy`).
Otherwise the body always comes back — sections that are missing or
unparseable produce issues and stay blank, never drop the document.

### Document layout

```text
# PERFORMANCE ARCHITECTURE CANVAS — <meta.title>
**Canvas Stage:** … · **Build Mode:** … · **Schema Version:** 3.0 ·
**Last Updated:** … · **Migration Status:** Native v3
**Người lập:** <meta.owner>           (only when non-empty)

## 1. GOAL | MỤC TIÊU                  — statement paragraph, then
                                         **Bối cảnh & phạm vi:** …
## 2. KEY RESULT + CRITICAL OUTPUTS / CS — one table; the "Loại" column
                                         is "Key Result" (kr) or
                                         "Critical Output" (outputs[])
## 3. SOLUTION DIRECTION + LEVER BEHAVIORS — **Solution Direction:**,
                                         **Logic chốt hướng …:**, table
## 4. CONDITIONS | 6 BOXES             — one row per canonical box
## 5. ACTION EXPERIMENT                — table + **Rủi ro …:** bullet list
## 6. FOLLOW-UP EVIDENCE …             — ### Measurement Plan /
                                         ### Observed Evidence /
                                         ### Lịch Review & bài học
```

Column order per table matches the legacy headers verbatim. Cell content
is position-mapped; header text is not trusted. `boxes` always emits and
parses all six rows (drafts included — `boxes.length(6)` is schema-level).

### Cell escaping (reversible both directions)

| raw cell text | Markdown cell |
|---|---|
| `\` | `\\` |
| `\|` | `\|` (escaped pipe) |
| `*` | `\*` |
| newline / `\r` | `\n` / `\r` (literal two-char sequences) |

Unknown `\x` sequences import verbatim (backslash kept). A cell that is
*only* a placeholder — `TBD`, `(chưa điền|chưa đặt tên|chưa có dữ liệu)`,
`—`/`–` — normalizes to `""` on import (schema-3.0 "no data yet"
semantic, same rule the legacy importer applies). Export protects a real
`(…)` value by escaping the first paren; an unprotectable collision
(`TBD`, `—`) warns `PLACEHOLDER_COLLISION`-style text at export time —
and the same check applies to prose/meta fields (`meta.title`,
`meta.owner`, labeled values, risk lines).

**Grammar divergence vs. the legacy UI.** The old
`canvas-online/index.html` parser never escapes cells: it joins
multi-line cell text with `"; "` and would split a raw `|` mid-cell.
This module instead emits escaped `\n` / `\|` sequences. The new parser
reads old documents fine (a `"; "` join is just text, and unescaped
pipes were already ambiguous there), but the **old UI will display the
literal `\n` / `\|` sequences** until Task 2.5 rewires it onto these
functions. Export Markdown is therefore a 2.5-onward artifact.

Whole-cell `**…**`/`*…*` emphasis unwraps on import (hand-formatted docs);
exported cells escape `*` so canonical text survives.

### Box→behavior links travel as names

`boxes[].behavior_id` (a UUID) is written as the behavior's **name** in
the "Hành vi liên quan" column — Markdown carries no ids. On import the
name resolves by exact trimmed match against `behaviors[].behavior`:

- exactly 1 hit → linked;
- `""` or literal `Cần xác nhận` with no matching behavior → `null`
  (unconfirmed — allowed in draft, publish still rejects);
- 0 or >1 hits → blocking `AMBIGUOUS_OR_MISSING_REFERENCE` issue at
  `boxes.<i>.behavior_id`; the row is preserved and `behavior_id` stays
  `null`. No substring/folded matching — never a guess.

Marker collision: a behavior may literally be named `Cần xác nhận` —
a real name match wins over the undecided marker, and the genuine
ambiguity is surfaced as a `MARKER_COLLISION` warning (import) and an
export warning naming `boxes.<i>` (a linked box whose target has that
name produces a cell indistinguishable from "undecided"). When such a
behavior exists, undecided boxes export an empty cell instead of the
marker text (also warned) so "undecided" is never misread as a link.

### Loss rules (never silent)

- Row `id`s are not in the document — every import regenerates UUIDs.
  Identity in Markdown is positional; use JSON for stable ids.
- Fields Markdown cannot carry — `observed[].measurement`,
  `assignee_user_id` (boxes/actions) — emit `JSON_REQUIRED_FOR_EXTENSIONS`
  (exact string in `warnings`) plus a detail line per location. A dangling
  `behavior_id` (no matching `behaviors[].id`) emits a blank link cell
  plus a warning. **JSON export/import stays the lossless path.**
- Issue codes emitted by `parseMarkdown`: `NOT_A_CANVAS` (error),
  `schema` (error, final gate), `AMBIGUOUS_OR_MISSING_REFERENCE` (error),
  `MISSING_TITLE`, `MISSING_SECTION`, `MISSING_SUBSECTION`,
  `MISSING_TABLE`, `MISSING_KEY_RESULT`, `MISSING_META`, `MISSING_BOX`,
  `UNKNOWN_SECTION`, `UNKNOWN_SUBSECTION`, `UNPARSED_CONTENT`,
  `DUPLICATE_LABEL`, `UNRECOGNIZED_BOX`, `AMBIGUOUS_BOX`,
  `DUPLICATE_BOX`, `DUPLICATE_KEY_RESULT`, `MARKER_COLLISION`,
  `UNKNOWN_ROW_TYPE`, `COLUMN_COUNT_MISMATCH`, `LIST_TRUNCATED`,
  `INVALID_ENUM`, `INVALID_DATE`, `SCHEMA_VERSION_MISMATCH`,
  `RISKS_FORMAT` (all warnings unless noted).
- Meta labels (`**Canvas Stage:**`, `**Người lập:**`, …) are only read
  in the preamble before `## 1.` — a label-shaped line inside a section
  is content (and flags `DUPLICATE_LABEL`/`UNPARSED_CONTENT`), never
  overrides real metadata. Text after `**Rủi ro …:**` on the label line
  itself is imported into `risks`, not dropped.
- `meta.updated`, `actions[].start/deadline`, `plan/observed/reviews[].date`
  go through the same date rules as `fromLegacy` (ISO validated against the
  real calendar; anchored `DD/MM/YYYY` normalizes; garbage warns + blanks).
  `kr.deadline`/`outputs[].deadline` stay verbatim free text.
- `meta.stage`/`meta.mode`/`actions[].status` are required enums — absent
  or unknown text warns and falls back (`DRAFT`/`GUIDED`/`Chưa bắt đầu`),
  matching `fromLegacy`. Blankable enums warn and blank.
- Multi-line fields (`goal.statement` paragraph, `risks` bullet block)
  carry real newlines both directions — no warning. One-line fields —
  the `**Label:**` values (`goal.context`, `solution.direction/logic`),
  `meta.owner`, the `#` title — genuinely cannot hold `\n`; `toMarkdown`
  warns only for those, and the importer joins continuations with a
  space.
- Lists respect schema bounds on import (`outputs` ≤3, `behaviors` ≤5)
  with `LIST_TRUNCATED` warnings naming the dropped rows; fully-blank
  table rows carry no content and are dropped silently by design.

`canvas-online/index.html` is intentionally untouched in this task — the
legacy UI rewires to `parseMarkdown`/`toMarkdown` in Task 2.5.
