# Phase 4 — Coaching reports, operations & customer delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chấm ORACLE bằng AI local, lưu/chia sẻ report đúng đối tượng và bàn giao bundle có restore/upgrade evidence.

**Architecture:** Coaching session/report module có ACL riêng không kế thừa canvas. Tái sử dụng adapter/runs Phase3, giữ transcript trong memory; maintenance credential chạy retention/backup tách runtime.

**Tech Stack:** TypeScript, Express, Knex/pg, PostgreSQL, Zod, Vitest/Supertest, Playwright; HTML/CSS/JS hiện tại.

**Spec:** [2026-09-19-gwp-app-real-design.md — revision 2](../specs/2026-09-19-gwp-app-real-design.md).

**Prerequisite:** Phase3 exit gate, nguồn rubric ORACLE có sẵn; không đổi auth/DB contract các phase trước.

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

- `server/src/modules/coaching/{schema,policy,service,routes,grader}.ts` và `0006-coaching.ts`.
- `server/prompts/oracle/`: rubric/prompt/manifest versioned.
- `web/coaching/`, `coaching-report/index.html`: session/input/preview/share UI.
- `server/src/jobs/retention.ts`, `scripts/ops/`: delivery/recovery scripts.
- `docs/operations/`, `docs/evaluation/`, `tests/{integration,e2e,ops}/`: handover.

## Task sequence

### Task 4.1: Coaching session/report schema và independent ACL

**Files:**

- Create: `server/src/db/migrations/0006-coaching.ts`, `server/src/modules/coaching/{schema,policy,service,routes}.ts`, `tests/integration/report-access.test.ts`
- Modify: `server/src/app.ts`, `server/openapi.yaml`

**Interfaces:**

- `createSession(actor,{coachUserId,coacheeUserId,canvasId?,occurredAt}): Promise<{id}>`.
- `assertReportRead(actor,reportId,tx?): Promise<void>` owner/creator/coach/active share.
- `listReports(actor,page)`, `getReport(actor,id)`; no report inheritance from subject policy.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/report-access.test.ts`. Coach phải manager coachee trừ owner nhập hộ; coachee/admin không tự đọc report; manager mới không inherit; wrongcompany404, list/count/filter.

```ts
expect((await f.api("member").get("/api/v1/reports/"+reportId)).status).toBe(404);
expect((await f.api("admin").get("/api/v1/reports/"+reportId)).status).toBe(404);
expect((await f.api("manager").get("/api/v1/reports/"+reportId)).status).toBe(200);
expect((await f.api("owner").get("/api/v1/reports/"+reportId)).status).toBe(200);
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/report-access.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Tables session/report/share composite company FKs. report_version unique(session_id,report_version); shares unique(report_id,user_id), revoked_at. Service enforces actor=coach and manager/coachee current relation; owner override audited. Canvas association needs independent read. Session update/delete not generic; report immutable snapshot. report read audit before response with metadata only. Inactive users cannot auth even if creator/share.

```sql
SELECT r.* FROM coaching_report r
JOIN coaching_session s ON s.id=r.session_id AND s.company_id=r.company_id
WHERE r.id=$1 AND r.company_id=$2 AND (
 $3::boolean OR r.created_by=$4 OR s.coach_user_id=$4 OR EXISTS(
  SELECT 1 FROM report_share sh WHERE sh.report_id=r.id AND sh.user_id=$4 AND sh.revoked_at IS NULL
 ));
-- $3 được tính từ role owner DB hiện tại; không nhận boolean từ client.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/report-access.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/db/migrations/0006-coaching.ts server/src/modules/coaching server/src/app.ts server/openapi.yaml tests/integration/report-access.test.ts
git commit -m "feat: model coaching reports with independent access policy"
```

### Task 4.2: ORACLE grader, transcript ephemeral và explicit save

**Files:**

- Create: `server/prompts/oracle/{instruction.md,rubric.json,manifest.json}`, `server/src/modules/coaching/grader.ts`, `tests/integration/grader.test.ts`, `tests/fixtures/ai/oracle-cases.json`
- Modify: `server/src/modules/ai/runs.ts`, `server/src/modules/coaching/service.ts`, `server/src/modules/coaching/routes.ts`, `server/openapi.yaml`

**Interfaces:**

- assistant:'oracle' extension to startRun({sessionId,transcript,consent,idempotencyKey}).
- `validateOracle(raw,transcript): OracleReportBody` checks actual rubric and quote ranges.
- `saveReport(actor,{sessionId,runId,idempotencyKey}): Promise<{reportId,reportVersion}>` from server preview only.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/grader.test.ts`. Evidencequote không nằm transcript rejected; total wrong; revoked manager can't save new report; repeated save one version; body transcript không DB/log, restart410.

```ts
const saved=await f.api("manager").post("/api/v1/reports")
 .send({sessionId,runId,idempotencyKey:"accept-report"});
expect(saved.status).toBe(201);
const again=await f.api("manager").post("/api/v1/reports")
 .send({sessionId,runId,idempotencyKey:"accept-report"});
expect(again.body.reportId).toBe(saved.body.reportId);
expect(JSON.stringify(await f.db("ai_run").select("*"))).not.toContain("raw-transcript-marker");
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/grader.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Đọc oracle-coaching-model.md và validate_oracle_output.py, port rubric exact maxima/criteria/labels vào TS validator; no invented grading rubric. Register oracle in AI service without canvas required; session permission separate. Consent/input cap/context/cancellation same runner. Save actor-scoped cached validated preview + prompt/model/config provenance; company/session lock serializes version. Copy selected evidence quotes allowed in accepted report, not entire transcript. Destroy raw transcript memory after inference. ai_run FK SET NULL and immutable provenance.

```ts
const receipt=await withReceipt(tx,scope,key,hash,async()=>{
 const max=await tx("coaching_report").where({session_id:sessionId}).max("report_version as n").first();
 const version=Number(max?.n ?? 0)+1;
 const [row]=await tx("coaching_report").insert({
  id:randomUUID(),company_id:actor.companyId,session_id:sessionId,
  report_version:version,body:preview.validatedBody,provenance:preview.provenance,
  ai_run_id:runId,created_by:actor.userId,created_at:clock()
 }).returning("id");
 return {resultId:row.id};
});
// scope.operation="save-report"; kiểm permission và lock trước receipt lookup.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/grader.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/prompts/oracle server/src/modules/coaching server/src/modules/ai/runs.ts tests/integration/grader.test.ts tests/fixtures/ai/oracle-cases.json server/openapi.yaml
git commit -m "feat: add validated ORACLE grading and reviewed report snapshots"
```

### Task 4.3: Share/revoke/delete và report-to-Renderer bridge

**Files:**

- Create: `tests/integration/report-sharing.test.ts`, `server/src/modules/coaching/renderer-input.ts`
- Modify: `server/src/modules/coaching/{service,routes}.ts`, `server/src/modules/ai/{runs,routes}.ts`, `server/openapi.yaml`

**Interfaces:**

- `shareReport(actor,reportId,userId)`, `revokeShare(actor,reportId,userId)`, `deleteReport(actor,reportId,{confirm:true})`: coach/owner only.
- `loadReportForRenderer(actor,reportId,canvasId): Promise<{sessionNotes:string,sourceReportId:string}>` checks both ACLs.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/report-sharing.test.ts`. Explicit share lets coachee read; revoked immediately404; share oldversion doesn't share newversion; delete cleans shares; renderer actor needs report AND canvas permission.

```ts
await f.api("manager").put("/api/v1/reports/"+reportId+"/shares/"+f.ids.member).send({});
expect((await f.api("member").get("/api/v1/reports/"+reportId)).status).toBe(200);
await f.api("manager").delete("/api/v1/reports/"+reportId+"/shares/"+f.ids.member);
expect((await f.api("member").get("/api/v1/reports/"+reportId)).status).toBe(404);
expect((await f.api("member").post("/api/v1/ai/runs").send({
 assistant:"renderer",reportId,canvasId,consent:true,idempotencyKey:"bridge"
})).status).toBe(404);
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/report-sharing.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Transaction company lock share/delete, current coach/owner role checked. Share applies exact report version. Deletion confirmed body+shares, audit metadata retained. Purge run previews referencing deleted report; receipt replay won't expose deleted result. Bridge whitelist coaching action recommendations selected by user, no coach grading/whole transcript copied to canvas; preview diff. Foreign report same id404. Export/print read through report policy and audit.

```ts
await assertReportRead(actor,reportId,tx);
await canvasService.assertWrite(actor,canvasId,tx);
// renderer-input.ts extract only approved actionable notes;
// user selects fields, server validates field paths from report schema.
// Never concatenate JSON.stringify(report) as canvas content.
// Input report provenance remains internal metadata, not sharing report ACL.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/report-sharing.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add tests/integration/report-sharing.test.ts server/src/modules/coaching server/src/modules/ai server/openapi.yaml
git commit -m "feat: add explicit report sharing and authorized renderer bridge"
```

### Task 4.4: Report UI và ORACLE evaluation

**Files:**

- Create: `web/coaching/{session,grader,report,sharing}.js`, `tests/e2e/coaching.spec.ts`, `docs/evaluation/oracle.md`
- Modify: `coaching-report/index.html`, `scripts/build-public.ts`, `web/ai/panel.js`

**Interfaces:**

- UI pick coach/coachee/session, paste transcript, consent/start/cancel, preview/save.
- Report detail/share/delete/export require server ACL; selected action transfer opens Renderer with dual access.

- [x] **Step 1: Viết test đỏ** trong `tests/e2e/coaching.spec.ts`. Không localStorage transcript/report; preview save explicit; share coachee before/after; delete confirm; old manager report remains only if originally coach, new manager denied.

```ts
await page.goto("/coaching-report/");
await page.getByLabel("Transcript").fill("Transcript nội bộ cho kiểm thử");
await expect(page.getByRole("button",{name:"Chấm phiên"})).toBeDisabled();
await page.getByLabel("Đồng ý xử lý nội dung bằng AI nội bộ").check();
await page.getByRole("button",{name:"Chấm phiên"}).click();
await expect(page.getByRole("button",{name:"Lưu báo cáo"})).toBeVisible();
expect(await page.evaluate(()=>localStorage.getItem("gwp-coaching-report-v1"))).toBeNull();
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm run test:e2e -- tests/e2e/coaching.spec.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Replace old STORE_KEY/save/load with memory form and server report. Clear transcript on completed run/cancel/page leave per UX warning, explicit upload text only <=1MiB. Safe render quotes, labels uncertainty and human-only HR decisions. Evaluation actual sample-transcript + adversarial/missing/contradictory Vietnamese; freeze prompt/rubric source checksum and score reviewer rubric. Print report from authorized current fetch, no preloaded global data. — eval trên model thật: xem ngoại lệ 1

```ts
const transient={transcript:""};
function clearTranscript() {
 transient.transcript="";
 document.querySelector("textarea[name=transcript]").value="";
}
// Không setItem; beforeunload chỉ cảnh báo dữ liệu nhập chưa xử lý, không tự save.
// Load persisted report chỉ qua /api/v1/reports/:id, không từ query body hoặc localStorage.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm run test:e2e -- tests/e2e/coaching.spec.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add web/coaching tests/e2e/coaching.spec.ts docs/evaluation/oracle.md coaching-report/index.html scripts/build-public.ts web/ai/panel.js
git commit -m "feat: finish consented coaching report workflow"
```

### Task 4.5: Retention, key rotation và ops security

**Files:**

- Create: `server/src/jobs/retention.ts`, `scripts/ops/rotate-key.ts`, `tests/integration/retention.test.ts`, `docs/operations/security-retention.md`
- Modify: `compose.yaml`, `server/src/security/secrets.ts`, `server/src/modules/settings/service.ts`

**Interfaces:**

- `runRetention(maintenanceDb,now): Promise<{auditDeleted,aiDeleted,receiptsDeleted}>` advisory lock, bounded batches.
- `rotate-key --from <version> --to <version>` secrets from protected mounts, transactional envelope rewrite.
- Owner settings may increase default365d audit/90dAI/30dlogs; receipts7d.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/retention.test.ts`. Runtime account cannot delete audit, maintenance can expired only; ai_run cleanup preserves provenance and FK null; shares expire only explicit revoke not manager change; key decrypt after rotate/backup.

```ts
await runRetention(maintenanceDb,new Date("2027-09-21T00:00:00Z"));
const report=await f.db("coaching_report").where({id:reportId}).first();
expect(report.ai_run_id).toBeNull();
expect(report.provenance).toEqual(originalProvenance);
await expect(f.db("audit_event").delete()).rejects.toMatchObject({code:"42501"});
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/retention.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Migration FK AI SET NULL for report/version/draft; old metadata deletes never remove published data. Audit cleanup via separate maintenance credential/job container; no deletion API/runtime privileges. Logging driver max-size/max-file and age-aware operational rotation30d. Delete expired consumed tokens and one-time tokens only after revocation horizon; preserve reuse detection while family active. Config retention can only increase lower bounds. Rotation validates decrypt all rows before committing switch, encrypted old keys retain backup recovery window; no secrets stdout.

```sql
DELETE FROM ai_run WHERE id IN (
 SELECT id FROM ai_run WHERE created_at < $1
 AND status IN ('succeeded','failed','cancelled','interrupted')
 ORDER BY created_at LIMIT 1000
);
-- FK ON DELETE SET NULL preserves report/version rows; immutable provenance is separate.
-- Audit cleanup executes only under maintenance role, batches and advisory lock.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/retention.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/jobs scripts/ops/rotate-key.ts tests/integration/retention.test.ts docs/operations/security-retention.md compose.yaml server/src/security/secrets.ts server/src/modules/settings/service.ts
git commit -m "feat: enforce retention and recoverable secret rotation"
```

### Task 4.6: Backup/restore, offline bundle và upgrade rehearsal

**Files:**

- Create: `scripts/ops/{bundle,upgrade-check}.ts`, `tests/ops/recovery.test.ts`, `docs/operations/{deployment-vn,recovery,upgrade}.md`, `release-manifest.json`
- Modify: `scripts/ops/{backup,restore-test}.ts`, `Dockerfile`, `compose.yaml`, `README.md`

**Interfaces:**

- `bundle --output <directory>` image archives/checksums/config templates/docs, no customer secrets/data.
- Backup pg_dump-Fc encrypted 30 daily copies elsewhere; secrets backup separate.
- `restore-test` namespaced target only, role recreation, schema version and decryption checks; target confirmed by operator.

- [x] **Step 1: Viết test đỏ** trong `tests/ops/recovery.test.ts`. Restore clean PostgreSQL with runtime/migrator/maintenance grants, last version/draft intact, key decrypt, session revocation on restore; unsupported migration downgrade refused; Internet cut runtime.

```ts
const evidence=await runRecoveryDrill({sourceFixture:f,targetDatabase:"gwp_restore_test"});
expect(evidence.checks).toMatchObject({
 roles:true,login:true,canvasHistory:true,reportAcl:true,keyDecrypt:true,publish:true
});
expect(evidence.restoredCustomerDatabase).toBe(false);
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/ops/recovery.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Define runRecoveryDrill in tests/helpers/recovery.ts spawning scripts into dedicated DB/container. pg_dump doesn't supply roles; bootstrap roles/grants scripted. Backup includes encrypted manifest/release/schema data; secrets export separate with encryption tool operator approved. Daily scheduler/retention and alert failure, storage separate failure domain. Upgrade lock migrations, maintenance mode, backup before; rollback app only compatible otherwise restore and communicate RPO. Image archive for air-gap excludes model weights/customer secrets. Runbook Vietnamese exact start/HTTPS/LLM/log retention/full disk/recovery/key rotation commands. — scheduler: operator cron (compose.yaml gợi ý), chưa có alert

```sh
npm run ops:backup -- --output /tmp/gwp-delivery.dump
npm run ops:restore-test -- --backup /tmp/gwp-delivery.dump
npm test -- tests/ops/recovery.test.ts
# Đo elapsed và backup age: mục tiêu RTO<=4h, RPO<=24h, không coi là SLA.
# Upgrade rehearsal: release Phase3 fixture -> Phase4 migrations -> tests -> documented restore.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/ops/recovery.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add scripts/ops tests/ops/recovery.test.ts tests/helpers/recovery.ts docs/operations/deployment-vn.md docs/operations/recovery.md docs/operations/upgrade.md release-manifest.json Dockerfile compose.yaml README.md
git commit -m "feat: package offline delivery and rehearse database recovery"
```

### Task 4.7: End-to-end acceptance và benchmark pilot

**Files:**

- Create: `tests/e2e/journey.spec.ts`, `tests/performance/pilot.ts`, `docs/operations/acceptance.md`
- Modify: `package.json`, `docs/operations/pilot.md`

**Interfaces:**

- `npm run test:performance` seeded test-only500users/5000canvas/100000versions,50web sessions.
- Evidence docs phase4 includes command outputs, resource limits, payload distribution, p95 non-AI/export.

- [x] **Step 1: Viết test đỏ** trong `tests/e2e/journey.spec.ts`. Full owner setup→org→activate→member canvas→manager Renderer→publish→grader→share→revoke; disconnected Internet, local LLM still reachable; forbidden ID/list/export blocked.

```ts
await loginAs(page,"member");
await page.goto("/dashboard.html");
await expect(page.getByText("Canvas cá nhân",{exact:true})).toBeVisible();
await expect(page.getByRole("link",{name:"Quản trị tổ chức"})).toHaveCount(0);
// Full journey uses separate browser contexts for owner/manager/member.
// Assert each published version number and report share before/after revoke.
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm run test:e2e -- tests/e2e/journey.spec.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Create performance seed with explicit test DB marker and unique company, never production. Measure auth/read/write/dashboard traffic distributions50sessions on4vCPU8GiB app+DB excluding LLM; payload sizes and latency/error rates output JSON. Gate p95<=500ms ordinary APIs, no fabricated pass if hardware differs. E2E fixture local fake LLM deterministic; separate real local model acceptance manual. Scan runtime outbound requests for CDN/Internet and logs for known transcript/key markers.

```ts
const latencies:number[]=[];
function percentile95(values:number[]):number {
 const sorted=[...values].sort((a,b)=>a-b);
 return sorted[Math.max(0,Math.ceil(sorted.length*0.95)-1)];
}
// pilot.ts records per-route latency/error counts, warmup excluded explicitly.
// Use test-only fixture guard; 50 concurrent sessions, not a loop reusing one connection.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm run test:e2e -- tests/e2e/journey.spec.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add tests/e2e/journey.spec.ts tests/performance/pilot.ts docs/operations/acceptance.md package.json docs/operations/pilot.md
git commit -m "test: add full customer journey and pilot acceptance evidence"
```

## Exit gate và bằng chứng bàn giao

- [x] All unit/integration/browser tests + typecheck/build/compose validation PASS.
- [ ] Local model quality accepted separately from deterministic fake-LLM tests.
- [x] No raw transcript/key in DB/logs/browser disk; reportACL/revocation tested end-to-end.
- [x] Clean-host restore and Phase3→4 upgrade rehearsal evidence; RPO/RTO measured, not assumed. — xem evidence/phase-4.md: rehearsal Phase3→4 + restore cluster sạch, RTO đo trên dev host; RPO vận hành đo tại pilot
- [ ] Offline runtime and pilot benchmark measured; documented exceptions require user decision, not auto-waiver. — offline runtime ✓; benchmark phần cứng pilot chưa đo (ngoại lệ 3)
- [ ] `docs/superpowers/evidence/phase-4.md` and Vietnamese handover runbook approved before customer delivery.

## Self-review coverage

Spec §6 coaching: Tasks1–4; §7 grader: Task2/4; §9 audit/retention/key/backup/upgrade: Tasks5/6; §10 performance/end-to-end: Task7. Source provenance §11: Task2/4. No STT/raw transcript retention/SSO/HA/mobile.
