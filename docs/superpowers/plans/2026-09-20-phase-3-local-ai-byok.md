# Phase 3 — Local AI BYOK, Canvas Renderer & Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tích hợp hai trợ lý canvas qua AI local có BYOK, preview có kiểm định và chỉ ghi khi người dùng xác nhận.

**Architecture:** Adapter HTTP nội bộ độc lập prompt/contracts; ai_run chỉ giữ metadata. Network inference ngoài transaction, ephemeral preview TTL15 phút, apply đi qua Canvas service và revision captured.

**Tech Stack:** TypeScript, Express, Knex/pg, PostgreSQL, Zod, Vitest/Supertest, Playwright; HTML/CSS/JS hiện tại.

**Spec:** [2026-09-19-gwp-app-real-design.md — revision 2](../specs/2026-09-19-gwp-app-real-design.md).

**Prerequisite:** Phase2 exit gate; endpoint local là dependency operator, không phải cloud. Report ID integration để Phase4.

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

- `server/src/modules/ai/{settings,adapter,runs,preview,renderer,coach}.ts`: mỗi file một trách nhiệm.
- `server/prompts/{renderer,coach}/`: instructions và contracts có version.
- `server/src/security/{secrets,ai-destination}.ts`: encryption/allowlist.
- `web/ai/`, `web/admin/ai.js`: UI local settings/run/preview.
- `tests/helpers/fake-llm.ts`: HTTP server local có script lỗi/stream.

## Task sequence

### Task 3.1: BYOK settings, encryption và allowlisted local endpoint

**Files:**

- Create: `server/src/security/{secrets,ai-destination}.ts`, `server/src/modules/ai/{settings,routes,schema}.ts`, `tests/integration/ai-settings.test.ts`
- Modify: `server/src/app.ts`, `server/openapi.yaml`, `.env.example`

**Interfaces:**

- `encryptSecret(plain,keyVersion): {ciphertext,iv,tag,keyVersion}`; `decryptSecret(envelope):string` server-only.
- `saveAiSettings(actor,input): Promise<PublicAiSettings>`; public returns configured, never key/ciphertext.
- `validateAiDestination(url,allowedHosts): URL`; allow host+port, explicit HTTP opt-in.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/ai-settings.test.ts`. Member403/admin200; key absent public/log; wrongAPP_KEY decryption controlled error; external/redirect denied; private allowlisted address valid.

```ts
const r=await f.api("admin").put("/api/v1/settings/ai").send({
 enabled:true,baseUrl:"https://llm.internal:8443/v1",apiKey:"local-secret",model:"pilot"
});
expect(r.status).toBe(200);
expect(JSON.stringify(r.body)).not.toContain("local-secret");
expect(r.body.configured).toBe(true);
expect((await f.api("member").get("/api/v1/settings/ai")).status).toBe(403);
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/ai-settings.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

AES-256-GCM random nonce + key-version envelope; APP_KEY decoded expected32bytes. Version config on changes, preserve key if omitted, explicit clear separate command. Bounds timeout<=180s default, output8192, concurrency2. Resolve/connect destination against operator network/host policy; no userinfo/redirect, no blanket block private IP. No browser direct AI calls or disable TLS verification. Add rate limit settings test.

```ts
const iv=randomBytes(12);
const cipher=createCipheriv("aes-256-gcm",key,iv);
cipher.setAAD(Buffer.from(companyId+":"+keyVersion));
const encrypted=Buffer.concat([cipher.update(plain,"utf8"),cipher.final()]);
const envelope={ciphertext:encrypted.toString("base64"),iv:iv.toString("base64"),
 tag:cipher.getAuthTag().toString("base64"),keyVersion};
// Bind decrypt AAD to company; GET settings projects fields, never returns envelope.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/ai-settings.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/security server/src/modules/ai server/src/app.ts server/openapi.yaml .env.example tests/integration/ai-settings.test.ts
git commit -m "feat: configure encrypted local AI BYOK"
```

### Task 3.2: Adapter chat-completions, connection test và cancellation

**Files:**

- Create: `server/src/modules/ai/adapter.ts`, `tests/helpers/fake-llm.ts`, `tests/unit/ai-adapter.test.ts`
- Modify: `server/src/modules/ai/routes.ts`, `server/openapi.yaml`

**Interfaces:**

- `complete({config,messages,maxOutputTokens,signal,onDelta}): Promise<{text,usage?:{inputTokens,outputTokens}}>`.
- `testConnection(actor): Promise<{ok,streaming,model}>` synthetic only; config context limit operator-provided, probe verifies supported capabilities not arbitrary discovery.

- [x] **Step 1: Viết test đỏ** trong `tests/unit/ai-adapter.test.ts`. Fake LLM split UTF8/SSE frames, [DONE], non-stream, upstream401/429/5xx, oversized output, timeout180s via fake clock, aborted signal closes connection.

```ts
const controller=new AbortController();
const task=adapter.complete({config:localConfig,messages:[{role:"user",content:"Kiểm tra"}],
 maxOutputTokens:100,signal:controller.signal,onDelta:()=>{}});
controller.abort();
await expect(task).rejects.toMatchObject({code:"AI_CANCELLED"});
expect(fakeLlm.requests[0]?.body?.messages).not.toContainEqual({content:"customer data"});
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/unit/ai-adapter.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Implement fake HTTP local server with request capture redacted in fixture, configure exact allowed address. Fetch redirect:error, AbortSignal combines timeout/client abort; incremental TextDecoder and SSE line buffering, limit bytes as well tokens. Content/role only, never enable tools/functions. Test uses small synthetic prompt. Error envelope has stable AI_* code and redacted upstream status, no raw provider error/key. Usage optional, don't estimate fake counts.

```ts
const response=await fetch(new URL("chat/completions",baseWithTrailingSlash),{
 method:"POST",redirect:"error",signal,
 headers:{"Content-Type":"application/json",Authorization:"Bearer "+apiKey},
 body:JSON.stringify({model,messages,max_tokens:maxOutputTokens,stream:true})
});
// On 429 map AI_BUSY; 401 AI_AUTH_FAILED; 5xx AI_UNAVAILABLE.
// Parse text/event-stream incrementally; if configured non-stream parse bounded JSON instead.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/unit/ai-adapter.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/modules/ai/adapter.ts server/src/modules/ai/routes.ts tests/helpers/fake-llm.ts tests/unit/ai-adapter.test.ts server/openapi.yaml
git commit -m "feat: add bounded and cancellable local inference adapter"
```

### Task 3.3: AI run state, consent, idempotency và bounded preview

**Files:**

- Create: `server/src/db/migrations/0005-ai.ts`, `server/src/modules/ai/{runs,preview}.ts`, `tests/integration/ai-runs.test.ts`
- Modify: `server/src/modules/ai/routes.ts`, `server/src/index.ts`, `server/openapi.yaml`

**Interfaces:**

- `startRun(actor,{assistant,canvasId,notes,consent,idempotencyKey}): Promise<{runId}>`.
- `getRun(actor,runId)`, `cancelRun(actor,runId)`, authenticated GET /ai/runs/:id/events via fetch.
- `putPreview(runId,actorId,value,base):void`; `getPreview(actor,runId)` TTL900s and bounded byte budget.
- `GET /ai/runs/:id` trả metadata cho actor tạo run; GET events và cancel kiểm cùng actor/session hiện hành. Restart chuyển cả queued lẫn running sang interrupted để không giữ slot vô hạn.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/ai-runs.test.ts`. No consent400, invalid rights404; 2 active/company third429; samekey no duplicate; changedhash409; expiry410; restart marks interrupted; raw notes absent DB/log.

```ts
const body={assistant:"renderer",canvasId,notes:"private-note-unique",consent:true,idempotencyKey:"same-run"};
const a=await f.api("member").post("/api/v1/ai/runs").send(body);
const b=await f.api("member").post("/api/v1/ai/runs").send(body);
expect(a.body.runId).toBe(b.body.runId);
expect((await f.api("member").post("/api/v1/ai/runs").send({...body,notes:"different"})).status).toBe(409);
expect(JSON.stringify(await f.db("ai_run").select("*"))).not.toContain("private-note-unique");
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/ai-runs.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Persist metadata/hash only. Admission serialized company lock (queued/running count<2); no waiting queue, queued is brief admitted state. Capture base version/draft revision/input hash/config revision at start; read allowed snapshot server-side. Temporary preview actor-scoped TTL15m, cap32MiB/company and 128MiB/process; evict completed oldest with explicit410. Validate1MiB before inference/context token budget from adapter config. Streaming subscribers authenticated owner of run, periodically session check; disconnect cancels upstream. Restart running→interrupted. Transcript/notes memory disposed at completion/cancel.

```ts
const hashInput=createHash("sha256").update(canonicalRequest).digest("hex");
await db.transaction(async tx=>{
 await lockCompany(tx,actor.companyId);
 // Find unique(company_id,actor_id,assistant,idempotency_key).
 // Same hash -> existing run ID; mismatch ->409; active count >=2 ->429.
 // Insert queued metadata + consent audit; commit before invoking adapter.
});
// Mark running outside long tx; completion validates then stores memory preview and safe metadata.
// If preview expired return 410 PREVIEW_EXPIRED; never auto-repeat a succeeded run.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/ai-runs.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/db/migrations/0005-ai.ts server/src/modules/ai server/src/index.ts server/openapi.yaml tests/integration/ai-runs.test.ts
git commit -m "feat: add consented idempotent AI runs and ephemeral previews"
```

### Task 3.4: Renderer prompt port, validation và CAS apply

**Files:**

- Create: `server/prompts/renderer/{instruction.md,manifest.json}`, `server/src/modules/ai/renderer.ts`, `tests/integration/renderer.test.ts`, `tests/fixtures/ai/renderer-cases.json`
- Modify: `server/src/modules/ai/routes.ts`, `server/src/modules/canvas/service.ts`, `server/openapi.yaml`

**Interfaces:**

- `validateRenderer(text,source:CanvasBody): {proposal:CanvasBody,issues:Issue[],diff}` dùng parseMarkdown.
- `applyRenderer(actor,runId,{expectedRevision,acceptedWarnings}): Promise<DraftDTO>` only; never publish.
- `manifest.json`: source path/revision/SHA256,promptVersion,contractVersion,licenseReview.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/renderer.test.ts`. Broken Markdown no draft, unsupported refs, changed existing draft409, revoked permission404, unchanged fields preserved, stage not auto-upgrade, tampered preview client rejected.

```ts
await f.api("member").put("/api/v1/canvases/"+canvasId+"/draft")
 .send({expectedRevision:capturedRevision,baseVersionId,body:changedBody});
const apply=await f.api("member").post("/api/v1/ai/runs/"+runId+"/apply")
 .send({expectedRevision:capturedRevision,acceptedWarnings:[]});
expect(apply.status).toBe(409);
expect((await f.db("canvas_draft").where({canvas_id:canvasId}).first()).body).toEqual(changedBody);
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/renderer.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Read actual Renderer instruction source from spec §11, copy versioned with sha; remove code execution/download requirements, retain canonical content/evidence labels. Parser validates full proposal, preserve stable IDs by matching original unique rows, no fabricated observed. Apply server cached proposal only, check captured revision/base against current including null no-draft case; conflict if changed. User accepts warnings by IDs tied preview hash; source/provenance copy to draft then published snapshot. Manual edit proposal through normal editor service after valid apply.

```ts
if(currentDraft?.revision !== preview.capturedDraftRevision ||
   canvas.current_version_id !== preview.capturedVersionId)
  throw new AppError(409,"AI_BASE_CHANGED","Canvas đã thay đổi; hãy so sánh lại");
// expectedRevision phải khớp cả request lẫn captured revision, không lấy revision mới để bypass.
// persist proposal bằng canvas service trong company/canvas lock; không gọi publish ở đây.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/renderer.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/prompts/renderer server/src/modules/ai/renderer.ts server/src/modules/ai/routes.ts server/src/modules/canvas/service.ts server/openapi.yaml tests/integration/renderer.test.ts tests/fixtures/ai/renderer-cases.json
git commit -m "feat: integrate reviewed Renderer proposals with canvas drafts"
```

### Task 3.5: Canvas Coach rubric và epistemic output

**Files:**

- Create: `server/prompts/coach/{instruction.md,manifest.json}`, `server/src/modules/ai/coach.ts`, `tests/unit/coach-output.test.ts`, `tests/fixtures/ai/coach-cases.json`

**Interfaces:**

- `CoachOutput` schema: rubricVersion, criteria[{id,score,max,evidenceRefs}], total, advice[{kind,text,sourceRefs}].
- `validateCoachOutput(raw,canvas): CoachOutput`; no canvas mutation method.

- [ ] **Step 1: Viết test đỏ** trong `tests/unit/coach-output.test.ts`. Điểm vượt max, sum mismatch, missing evidence, invented reference, labels ngoài enum, incomplete JSON rejected; no confidence laundering.

```ts
expect(()=>validateCoachOutput({...validCoach,total:99},canonicalBody))
 .toThrow("SCORE_TOTAL_MISMATCH");
expect(()=>validateCoachOutput({...validCoach,
 advice:[{kind:"Fact",text:"Đã đạt KPI",sourceRefs:["missing-id"]}]},canonicalBody))
 .toThrow("UNKNOWN_EVIDENCE_REFERENCE");
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/unit/coach-output.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Read 04_master_instruction/05_prompt_stack/knowledge from source; freeze actual rubric criterion IDs/max, do not invent weights. JSON contract follows source rubric + evidence refs into input IDs. Sum server computed and model total compared. No observations -> missing-evidence explicit, not made-up score justification. Validate structured output server; escape rendered text, no raw model HTML. Cache preview only15m, no persistent chat.

```ts
const AdviceKind=z.enum(["Fact","Interpretation","Assumption","Hypothesis","Recommendation"]);
const sum=parsed.criteria.reduce((n,c)=>n+c.score,0);
if(sum!==parsed.total) throw new Error("SCORE_TOTAL_MISMATCH");
for(const c of parsed.criteria) {
 if(c.score<0 || c.score>c.max) throw new Error("SCORE_OUT_OF_RANGE");
}
// criterion max phải khớp bảng rubric versioned, không tin max do model tự chọn.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/unit/coach-output.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/prompts/coach server/src/modules/ai/coach.ts tests/unit/coach-output.test.ts tests/fixtures/ai/coach-cases.json
git commit -m "feat: validate Canvas Coach rubric and evidence output"
```

### Task 3.6: AI settings/streaming/preview UI và local-model evaluation

**Files:**

- Create: `web/admin/ai.js`, `web/ai/{panel,stream,preview}.js`, `tests/e2e/ai.spec.ts`, `docs/operations/local-ai.md`, `docs/evaluation/canvas-ai.md`
- Modify: `admin.html`, `canvas.html`, `canvas-online/index.html`, `scripts/build-public.ts`

**Interfaces:**

- Settings enable/key replace/test; canvas actions start/cancel/retry/preview/apply.
- `readEvents(response,onEvent,signal)` fetch-SSE không EventSource bearer trong URL.
- consent checkbox resets each run; request ID errors rendered without provider secrets.

- [ ] **Step 1: Viết test đỏ** trong `tests/e2e/ai.spec.ts`. AIoff edit works, streaming cancellation, missingkey, timeout, invalid proposal, consent unchecked can't run, explicit diff/apply, no auto-publish.

```ts
await page.goto("/canvas.html?id="+canvasId);
await page.getByRole("button",{name:"Dựng canvas từ phiên"}).click();
await expect(page.getByRole("button",{name:"Chạy AI",exact:true})).toBeDisabled();
await page.getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ").check();
await page.getByRole("button",{name:"Chạy AI",exact:true}).click();
await expect(page.getByTestId("ai-preview")).toBeVisible();
await expect(page.getByTestId("published-version")).toHaveText("v1");
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm run test:e2e -- tests/e2e/ai.spec.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Escape stream text, parse only after complete, render invalid output as plain text diagnostic not trusted Markdown HTML. Mask key input, no echo on reopen. Document local gateway auth/TLS/body logs disabled, model context/output limitations. Evaluation at least12 Việt fixtures: valid, thiếu evidence, mâu thuẫn, injection, long, duplicated names; record actual outcomes/model/prompt hash. Safety invalid-output/revocation cases all pass; business owner reviews rubric and proposed changes before phase accepted.

```sh
npm test -- tests/unit/ai-adapter.test.ts tests/unit/coach-output.test.ts tests/integration/renderer.test.ts
npm run test:e2e -- tests/e2e/ai.spec.ts
# Chạy bộ mẫu trên endpoint local đã được operator duyệt, không đưa secrets vào evidence.
# Ghi pass/fail từng fixture; không thay đánh giá chất lượng bằng tỷ lệ parse thành công.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm run test:e2e -- tests/e2e/ai.spec.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add web/admin/ai.js web/ai tests/e2e/ai.spec.ts docs/operations/local-ai.md docs/evaluation/canvas-ai.md admin.html canvas.html canvas-online/index.html scripts/build-public.ts
git commit -m "feat: complete local AI experience and evaluation gate"
```

## Exit gate và bằng chứng bàn giao

- [ ] Tất cả test adapter/run/Renderer/Coach/UI PASS; APIoff không cản canvas.
- [ ] Model local thật qua connection test + bộ12 mẫu được business reviewer duyệt; chưa có endpoint thì ghi blocked evaluation, không khẳng định chất lượng đạt.
- [ ] Timeout/cancel/restart/no-consent/revocation/stale draft có bằng chứng không ghi dữ liệu sai.
- [ ] `docs/superpowers/evidence/phase-3.md` gồm provenance redacted và quyết định reviewer.

## Self-review coverage

Spec §7 toàn bộ: Tasks1–6; §5 AI draft: Task4; §9 key/provenance: Tasks1/3/4. Renderer nhận report text thủ công ở phase này; report ID integration bổ sung Phase4 Task3. No raw AI outputs persisted except accepted canvas content.
