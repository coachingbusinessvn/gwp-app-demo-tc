# Phase 2 — Canonical canvas, versioning & internal pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng tạo/sửa/chốt canvas thật với dashboard đúng quyền, version bất biến và import/export có kiểm chứng.

**Architecture:** Schema thuần trong shared/canvas dùng chung editor/server; một draft mỗi canvas, published snapshots bất biến. Policy Phase1 chặn cả list/detail/export; transactions và revision chống mất dữ liệu.

**Tech Stack:** TypeScript, Express, Knex/pg, PostgreSQL, Zod, Vitest/Supertest, Playwright; HTML/CSS/JS hiện tại.

**Spec:** [2026-09-19-gwp-app-real-design.md — revision 2](../specs/2026-09-19-gwp-app-real-design.md).

**Prerequisite:** Phase1 exit gate; đọc blankState/parser/export Canvas Online và assets/data.js trực tiếp, không dùng fullVersion cho migration.

## Global Constraints

- PostgreSQL là engine duy nhất trong development, integration test và production.
- Khách hàng tự host tại Việt Nam và sở hữu dữ liệu; GoWise không giữ dữ liệu khách.
- AI chạy local/nội bộ do khách hàng cung cấp, vẫn dùng BYOK; không cloud fallback.
- Một deployment phục vụ một company; demo/production khác DB, secrets và volume.
- ActorContext do server xác thực; quyền nằm ở services, không tin body/role từ client.
- Không lưu bearer/refresh trong localStorage; không log nội dung coaching, key hoặc Authorization.
- Request JSON/import thường giới hạn 2 MiB; pagination mặc định 25, tối đa 100.
- Không triển khai code trong lượt lập plan. Chỉ tick checkbox khi bước thực thi có bằng chứng.
- Đọc [hợp đồng chung và thứ tự chạy](2026-09-20-implementation-roadmap.md) trước task đầu.
- Tất cả đường dẫn trong task tính từ repository root; lệnh npm chạy ở root.
- Code block trong bước triển khai xác định kernel/hợp đồng bắt buộc; tạo đủ exports, imports,
  route wiring và migration theo Files/Interfaces của task, không thay kiểm thử bằng mock DB.

## File Structure

- `shared/canvas/{schema,defaults,markdown,legacy,validation}.ts`: contract/parser thuần.
- `server/src/modules/canvas/{repository,service,routes,queries}.ts`: persistence/quyền.
- `server/src/modules/dashboard/`: published-only read models.
- `web/canvas/`: editor adapter/autosave/diff/export.
- `tests/fixtures/canvas/`: full Vietnamese fixtures và legacy brief.
- `0004-canvas.ts`, `server/src/shared/write-receipt.ts`: DB/concurrency.

## Task sequence

### Task 2.1: Canonical payload và legacy migration

**Files:**

- Create: `shared/canvas/{schema,defaults,legacy,validation}.ts`, `tests/unit/canvas-schema.test.ts`, `tests/fixtures/canvas/{canonical,legacy}.json`, `docs/contracts/canvas-payload.md`

**Interfaces:**

- `CanvasBody = z.infer<typeof CanvasBodySchema>`; `validateCanvas(body,mode:'draft'|'publish'): Issue[]`.
- `blankCanvas(clock:()=>Date): CanvasBody`; `fromLegacy(raw): {body:CanvasBody|null,warnings:string[]}`.
- Payload includes solution.direction/logic, risks:string, meta stage/mode; row IDs và measurement extension.

- [ ] **Step 1: Viết test đỏ** trong `tests/unit/canvas-schema.test.ts`. Kiểm toàn bộ field editor, enums, đủ 6 boxes, missing reference, VALIDATED thiếu evidence, unknown fields, brief không tạo body.

```ts
expect(fromLegacy({v:"v1",brief:true}).body).toBeNull();
const mapped=fromLegacy(legacyFull).body!;
expect(mapped.goal.statement).toBe(legacyFull.goal);
expect(mapped.solution.direction).toBe(legacyFull.direction);
expect(mapped.risks).toBe(legacyFull.risks.join("\n"));
expect(CanvasBodySchema.safeParse({...mapped,company_id:"injected"}).success).toBe(false);
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/unit/canvas-schema.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Trích mọi field blankState hiện tại kể cả solution và reviews. Schema strict cho nested objects, UUID rows; outputs1–3 behaviors2–5, boxes6 ở publish; draft cho phép field rỗng nhưng vẫn đúng kiểu/ref. Import preserve text, enum lỗi không thay default ngầm. Seed chỉ full snapshot, brief ghi migration notes. Field mapping documented: cur→current,tgt→target,due→deadline,beh→behavior,own→assignee_label, risks array→newline text. Blank observed row không coi là evidence.

```ts
export const Measurement = z.object({
  metricId:z.string().uuid(), definitionRevision:z.number().int().positive(),
  layer:z.enum(["BEHAVIOR","OUTPUT","RESULT"]), date:z.iso.date(),
  value:z.number().finite(), unit:z.string().min(1),
  baseline:z.number().finite(), target:z.number().finite()
}).strict();
// observed giữ value dạng text gốc, thêm measurement: Measurement.optional().
// Dùng .strict() cho mọi object; không dùng passthrough cho field quyền.
// schema_version=1 là payload version, meta schema nghiệp vụ vẫn "3.0".
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/unit/canvas-schema.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add shared/canvas tests/unit/canvas-schema.test.ts tests/fixtures/canvas docs/contracts/canvas-payload.md
git commit -m "feat: define canonical canvas payload and legacy adapter"
```

### Task 2.2: Markdown parser, import report và export round-trip

**Files:**

- Create: `shared/canvas/markdown.ts`, `tests/unit/canvas-markdown.test.ts`, `tests/fixtures/canvas/canonical.md`
- Modify: `canvas-online/index.html` (trích parser, giữ UI), `docs/contracts/canvas-payload.md`

**Interfaces:**

- `parseMarkdown(text:string): {body:CanvasBody,issues:Issue[]}`; `toMarkdown(body): {text:string,warnings:string[]}`.
- `Issue = {path:string,code:string,severity:'error'|'warning',message:string}` từ validation.ts.

- [ ] **Step 1: Viết test đỏ** trong `tests/unit/canvas-markdown.test.ts`. Tên hành vi lặp/mơ hồ, unknown sections, pipe/newline trong cells, tiếng Việt, stage, Markdown thiếu field; JSON giữ UUID, Markdown cảnh báo mất extensions.

```ts
const exported=toMarkdown(canonicalBody);
const parsed=parseMarkdown(exported.text);
expect(parsed.body.goal).toEqual(canonicalBody.goal);
expect(parsed.body.solution).toEqual(canonicalBody.solution);
expect(parsed.body.risks).toEqual(canonicalBody.risks);
expect(parsed.issues.filter(i=>i.severity==="error")).toEqual([]);
expect(toMarkdown(withMeasurement).warnings).toContain("JSON_REQUIRED_FOR_EXTENSIONS");
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/unit/canvas-markdown.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Tách parseCanvasMarkdown/sanitizeState nhưng bỏ silent truncation/defaulting. Dùng map tên duy nhất→ID; ambiguous thêm blocking issue. API import không nhận actor/company metadata. Golden fixture khóa 6 phần canonical, parse table escape. JSON export có body/schema_version, không password/org quyền; import external assignee ID phải confirm/match company phía service.

```ts
export function resolveNamedLink(name:string, rows:{id:string;name:string}[]): string {
  const hits=rows.filter(r=>r.name.trim()===name.trim());
  if(hits.length!==1) throw new Error("AMBIGUOUS_OR_MISSING_REFERENCE");
  return hits[0].id;
}
// Áp dụng ở adapter sau khi tạo row IDs; không substring-match.
// Không catch lỗi rồi bỏ cell; trả Issue.path và giữ nguyên nội dung để sửa.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/unit/canvas-markdown.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add shared/canvas/markdown.ts tests/unit/canvas-markdown.test.ts tests/fixtures/canvas/canonical.md canvas-online/index.html docs/contracts/canvas-payload.md
git commit -m "feat: add loss-aware canonical Markdown import and export"
```

### Task 2.3: Canvas persistence và permission-filtered API

**Files:**

- Create: `server/src/db/migrations/0004-canvas.ts`, `server/src/modules/canvas/{schema,repository,service,routes,queries}.ts`, `tests/integration/canvas-access.test.ts`
- Modify: `server/src/app.ts`, `server/openapi.yaml`

**Interfaces:**

- `createCanvas(actor,{ownerUserId,name,body}): Promise<{id,draft:{id,revision}}>`.
- `getCanvas(actor,id)`, `listCanvases(actor,{cursor?,limit?})`, `getVersion(actor,canvasId,versionId)`.
- `createCanvasService({db,policy,clock})`; `assertSubjectAccess` on owner for all reads/writes.
- `assertWrite(actor,canvasId,tx?): Promise<void>`: load canvas same company, assertSubjectAccess(owner), từ chối archived; exported cho report bridge Phase4.
- `createDraft(actor,canvasId): Promise<DraftDTO>`: POST /canvases/:id/draft, copy current published hoặc blank nếu chưa có; existing draft trả409, không xóa bản đang sửa.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/canvas-access.test.ts`. owner/self/subtree allow; admin thuần deny; list/count/detail/history đều filter; fake otherCompany; assignee không tự access.

```ts
const created=await f.api("member").post("/api/v1/canvases")
 .send({ownerUserId:f.ids.member,name:"Quý 4",body:canonicalBody});
expect(created.status).toBe(201);
expect((await f.api("admin").get("/api/v1/canvases/"+created.body.id)).status).toBe(404);
const list=await f.api("admin").get("/api/v1/canvases");
expect(list.body.items).not.toEqual(expect.arrayContaining([expect.objectContaining({id:created.body.id})]));
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/canvas-access.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Composite FK company/canvas IDs, current_version nullable circular FK added sau tạo version table. company/actor từ server, ownerUserId chỉ same company và subject quyền. draft unique canvas_id; published UPDATE/DELETE blocked runtime role. body JSONB validated. Index owner/company và version canvas/no. Empty production reads không fixture fallback. Seed demo canvas separate idempotent mapping, archive read-only.

```sql
CREATE UNIQUE INDEX canvas_one_draft ON canvas_draft(canvas_id);
CREATE UNIQUE INDEX canvas_version_number ON canvas_version(canvas_id,version_no);
ALTER TABLE canvas_version ADD CONSTRAINT version_canvas_company_fk
 FOREIGN KEY(company_id,canvas_id) REFERENCES canvas(company_id,id);
-- current_version_id FK phải gồm company_id, canvas id và version id để không trỏ canvas khác.
-- Không có /versions/:id PUT hoặc DELETE; GET vẫn kiểm subject access.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/canvas-access.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/db/migrations/0004-canvas.ts server/src/modules/canvas server/src/app.ts server/openapi.yaml tests/integration/canvas-access.test.ts
git commit -m "feat: persist canvases behind shared subject policy"
```

### Task 2.4: Draft CAS, idempotent publish, restore/archive/transfer

**Files:**

- Create: `server/src/shared/write-receipt.ts`, `tests/integration/canvas-concurrency.test.ts`
- Modify: `server/src/db/migrations/0004-canvas.ts`, `server/src/modules/canvas/service.ts`, `server/src/modules/canvas/routes.ts`, `server/openapi.yaml`

**Interfaces:**

- `saveDraft(actor,canvasId,{expectedRevision,baseVersionId,body})` → DraftDTO.
- `publish(actor,canvasId,{expectedRevision,idempotencyKey,changeSummary})` → {versionId,versionNo}.
- `restore(actor,canvasId,versionId,{expectedRevision?})`; `archive(actor,canvasId)`; `transferOwner(actor,canvasId,newOwnerId)` owner-only.
- `withReceipt(tx,scope,key,requestHash,write): Promise<{resultId}>` giữ7days.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/canvas-concurrency.test.ts`. 2 save same revision→200/409; publish retry không double; same key khác body409; revocation sau retry404; restore lịch sử không đổi, existing draft yêu cầu confirm/CAS.

```ts
const url="/api/v1/canvases/"+canvasId+"/draft";
const body={expectedRevision:1,baseVersionId:null,body:canonicalBody};
const results=await Promise.all([f.api("member").put(url).send(body),f.api("member").put(url).send(body)]);
expect(results.map(r=>r.status).sort()).toEqual([200,409]);
expect((await f.db("canvas_draft").where({canvas_id:canvasId}).first()).revision).toBe(2);
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/canvas-concurrency.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Protected writes lockCompany, then canvas FOR UPDATE; recheck current policy in tx. UPDATE WHERE revision CAS. Publish validates, uses max version+1 under canvas lock, inserts immutable snapshot/audit/receipt and deletes draft. Check receipt before missing draft but after permission. Restore old body copied into new draft based current version; if draft exists require expected revision+confirmation, no hidden discard. Archive prevents writes; transfer requires owner/current-company and audit.

```sql
UPDATE canvas_draft
SET body=$1::jsonb, revision=revision+1, updated_by=$2, updated_at=now()
WHERE canvas_id=$3 AND revision=$4
RETURNING *;
-- 0 rows => 409 DRAFT_CONFLICT.
-- Publish: permission → receipt lookup → lock draft/check expectedRevision/base →
-- validate → INSERT canvas_version → UPDATE canvas.current_version_id →
-- INSERT write_receipt + audit → DELETE canvas_draft → COMMIT.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/canvas-concurrency.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/shared/write-receipt.ts server/src/db/migrations/0004-canvas.ts server/src/modules/canvas server/openapi.yaml tests/integration/canvas-concurrency.test.ts
git commit -m "feat: make canvas edits conflict-safe and publication idempotent"
```

### Task 2.5: Editor API, autosave và diff/history UI

**Files:**

- Create: `web/canvas/{editor,autosave,diff,history}.js`, `tests/e2e/canvas.spec.ts`
- Modify: `canvas-online/index.html`, `canvas.html`, `scripts/build-public.ts`, `web/api.js`

**Interfaces:**

- UI adapter maps CanvasBody↔form without dropping fields/IDs.
- Autosave serializes own requests; only advances revision from server response.
- Draft load GET /canvases/:id/draft; published history GET /canvases/:id/versions.

- [ ] **Step 1: Viết test đỏ** trong `tests/e2e/canvas.spec.ts`. 2 tabs conflict preserves local text; reload saved draft; publish DRAFT stage remains valid; retry save, beforeunload, malicious text rendered inert.

```ts
await page.goto("/canvas-online/?canvas="+canvasId);
await page.getByLabel("Mục tiêu").fill("Mục tiêu mới");
await expect(page.getByTestId("save-state")).toHaveText("Đã lưu");
await page.reload();
await expect(page.getByLabel("Mục tiêu")).toHaveValue("Mục tiêu mới");
await page.getByRole("button",{name:"Chốt phiên bản"}).click();
await expect(page.getByTestId("version-number")).toHaveText("v1");
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm run test:e2e -- tests/e2e/canvas.spec.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Remove STORE_KEY/load/save localStorage from editor runtime; intentional explicit import legacy local copy requires user confirmation, never auto-upload. Serialize debounce saves; unmount warns unsaved; 409 freezes autosave, offers diff/copy local/reload, never automatic overwrite. History restore/export screens display permissions and immutable version. IDs supplied from API not PEOPLE globals. Diff uses escaped text and stable row ID.

```ts
let revision = initialDraft.revision;
async function saveCurrent(body) {
  const response=await apiFetch("/canvases/"+canvasId+"/draft",{
    method:"PUT",body:JSON.stringify({expectedRevision:revision,baseVersionId,body})
  });
  if(response.status===409){ setSaveState("Xung đột"); return; }
  if(!response.ok){ setSaveState("Lỗi"); return; }
  revision=(await response.json()).revision;
  setSaveState("Đã lưu");
}
// Define setSaveState in autosave.js; queue callers so only one saveCurrent runs at a time.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm run test:e2e -- tests/e2e/canvas.spec.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add web/canvas tests/e2e/canvas.spec.ts canvas-online/index.html canvas.html scripts/build-public.ts web/api.js
git commit -m "feat: connect canvas editor to revision-aware API"
```

### Task 2.6: Published dashboard, assignee IDs và measurement series

**Files:**

- Create: `server/src/modules/dashboard/{service,routes}.ts`, `tests/integration/dashboard.test.ts`, `tests/unit/measurement.test.ts`
- Create: `shared/canvas/measurement.ts`, `server/src/db/seed-canvas.ts`
- Modify: `assets/app.js`, `dashboard.html`, `employee.html`, `server/src/app.ts`, `server/openapi.yaml`

**Interfaces:**

- `getDashboard(actor): Promise<{people,attention,canvases}>` policy-filtered.
- `buildSeries(body:CanvasBody): Series[]`; same metricId+definitionRevision+unit, dedup observed row ID.
- `seedDemoCanvases(db)` uses fromLegacy full only; fixture seed version tracked.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/dashboard.test.ts`. Draft future observation không ảnh hưởng dashboard; same title different assignee; current date timezone rollover; missing evidence/changed unit no fabricated trend.

```ts
const result=await f.api("manager").get("/api/v1/dashboard");
expect(result.status).toBe(200);
expect(result.body.attention.every((x:{assigneeUserId:string})=>x.assigneeUserId===f.ids.manager)).toBe(true);
expect(result.body.canvases.find((x:{id:string})=>x.id===draftOnlyCanvas).status).toBe("unpublished");
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/dashboard.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Join latest published only and permitted owners; no unfiltered counts. Clock injectable, day difference company timezone; actions overdue if deadline<today and status not completed. Series uses latest snapshot cumulative observed, dedup row ID; no mixing units/baselines; skip no numeric extension, display no data. Demo trend from real fixture observed extension if available, do not assign fake evidence to text.

```ts
export function metricKey(m: {metricId:string;definitionRevision:number;unit:string}): string {
  return JSON.stringify([m.metricId,m.definitionRevision,m.unit]);
}
export function progress(value:number, baseline:number, target:number): number|null {
  if(target===baseline) return null;
  return (value-baseline)/(target-baseline)*100;
}
// Lower-is-better tự đúng khi target<baseline; không parseFloat("2,1 tỷ").
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/dashboard.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/modules/dashboard tests/integration/dashboard.test.ts tests/unit/measurement.test.ts shared/canvas/measurement.ts server/src/db/seed-canvas.ts assets/app.js dashboard.html employee.html server/src/app.ts server/openapi.yaml
git commit -m "feat: derive authorized dashboard from published evidence"
```

### Task 2.7: Export boundary, QA và Phase2 pilot gate

**Files:**

- Create: `web/canvas/export.js`, `tests/integration/canvas-export.test.ts`, `tests/e2e/canvas-export.spec.ts`, `docs/operations/pilot.md`
- Modify: `assets/export.js`, `server/src/modules/canvas/routes.ts`, `server/openapi.yaml`, `README.md`

**Interfaces:**

- GET /canvases/:id/versions/:versionId/export?format=json|markdown returns authorized content + warning metadata.
- POST /canvases/:id/export-preview for authorized current draft; browser Excel/PDF/PNG uses that payload and audit.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/canvas-export.test.ts`. Admin/other user 404, published JSON roundtrip exact, Markdown extension warning; formula-like string Excel not formula; PDF Vietnamese/long tables manual QA.

```ts
expect((await f.api("admin").get("/api/v1/canvases/"+canvasId+"/versions/"+versionId+"/export?format=json")).status).toBe(404);
const out=await f.api("member").get("/api/v1/canvases/"+canvasId+"/versions/"+versionId+"/export?format=json");
expect(out.body.body).toEqual(canonicalBody);
expect(out.body.schema_version).toBe(1);
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/canvas-export.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Export handlers call service/getVersion, audit format/ID only, never include private report data. Adapt existing XLSX inline strings, never emit formula cells from user text. Browser print PDF and PNG supported as presentation; bundle fonts. Build pilot walkthrough create/import/edit/publish/manager/export without AI. Screenshots narrow/wide and A4 multi-page, inspect truncation/accents.

```sh
npm test -- tests/unit/canvas-markdown.test.ts tests/integration/canvas-export.test.ts
npm run test:e2e -- tests/e2e/canvas-export.spec.ts
npm run build
# QA: canvas dài, dấu tiếng Việt, ô bắt đầu "="; XLSX mở không thực thi formula.
# PDF/PNG chỉ trình bày; JSON là nguồn bảo toàn toàn bộ nội dung.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/canvas-export.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add web/canvas/export.js tests/integration/canvas-export.test.ts tests/e2e/canvas-export.spec.ts docs/operations/pilot.md assets/export.js server/src/modules/canvas/routes.ts server/openapi.yaml README.md
git commit -m "feat: complete authorized canvas exports and pilot flow"
```

## Exit gate và bằng chứng bàn giao

- [ ] `npm test`, `npm run typecheck`, `npm run build`, canvas browser E2E PASS.
- [ ] Snapshot full legacy có golden tests; brief không biến thành lịch sử giả.
- [ ] Concurrent writes, retry publish và import/export không mất field đã kiểm.
- [ ] Pilot create→manager→export chạy khi AI tắt và Internet bị chặn.
- [ ] Ghi `docs/superpowers/evidence/phase-2.md` với QA PDF/PNG/Excel; review trước Phase3.

## Self-review coverage

Spec §3 canvas/receipt: Tasks3/4; §4 permissions: Tasks3/6/7; §5 toàn bộ: Tasks1–7; §11 port legacy: Tasks1/2/6; §10 pilot: gate. Không model inference, report hoặc realtime collaboration.
