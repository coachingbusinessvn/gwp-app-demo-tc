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

Draft mode never blocks on business completeness — a fully blank
`blankCanvas()` is a valid draft.

## `fromLegacy(raw)` — demo snapshot adapter

Input: one legacy version record (`assets/data.js` `CANVAS.*.versions[]`
shape). Output: `{ body, warnings }`.

**Never fabricate:** `brief: true` records, or records with no content keys
at all, return `{ body: null, warnings }` — briefs are migration notes, not
snapshots.

### Field map

| legacy | canonical | notes |
|---|---|---|
| `name` | `meta.title` | canvas-level field, flattened onto the record |
| `owner` | `meta.owner` | |
| `stage` | `meta.stage` | invalid → warn + `DRAFT` |
| `mode` | `meta.mode` | invalid → warn + `GUIDED` |
| `date` | `meta.updated` | normalized to ISO |
| `goal` / `context` | `goal.statement` / `goal.context` | verbatim |
| `direction` / `logic` | `solution.direction` / `solution.logic` | verbatim |
| `risks[]` | `risks` | joined with `"\n"` (a bare string passes through) |
| `kr.cur/tgt/due` | `kr.current/target/deadline` | `due` verbatim free text |
| `outputs[].cur/tgt/due` | `outputs[].current/target/deadline` | `due` verbatim |
| `behaviors[].beh/ctx/out/sign` | `behavior/context/outputs/signal` | |
| `boxes[].cond/ev/pri/act/own` | `condition/evidence/priority/action/assignee_label` | row order maps positionally onto `SIX_BOXES` |
| `boxes[].beh` | `boxes[].behavior_id` | exact name match → `behaviors[].id`; unknown → `null` + warning |
| `actions[].act/due/own/sup/cri/st` | `action/deadline/assignee_label/supporter_label/criteria/status` | `st` invalid → warn + `Chưa bắt đầu` |
| `plan[].base/src/col/ver` | `baseline/source/collector/verifier` | |
| `observed[].val/src/conf/learn/dec/ver` | `value/source/confidence/learning/decision/verifier` | |
| `reviews[].cp/be/oe/re/ok/no/ln/ver` | `checkpoint/behavior_evidence/output_evidence/result_evidence/works/not_works/learning/verifier` | absent review keys → `""` |
| `id`, `personId`, `v`, `week`, `change`, `brief` | — | server-owned bookkeeping/identity, recognized but not imported |

Rules:

- Dates (`date`, `*.start`, `*.due` on actions, `*.date` on plan/observed/
  reviews): ISO kept, `DD/MM/YYYY` normalized to ISO, anything else warns
  and blanks. `kr.due` / `outputs[].due` are free text — never normalized.
- Enums: exact match or warning + explicit fallback (no silent defaults,
  no diacritic-folding guesses).
- Unknown keys — top-level or inside any row — always warn; privilege-shaped
  keys (`company_id`, `user_id`, …) are dropped with a warning, never
  imported.
- Missing content sections warn once and fall back to the blank-state shape
  (1 output, 2 behaviors, 6 blank boxes, 1 action, 3 plan rows, 1 observed
  row, 2 review checkpoints). An explicitly empty list (e.g.
  `observed: []`) is a real state and stays empty.
- Every mapped row gets a fresh UUID `id`; legacy records carry none.
- Mapped bodies are `CanvasBodySchema`-valid by construction; the tc2
  fixture maps with zero warnings and passes `validateCanvas(_, "publish")`.
