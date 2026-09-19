# Phase 1 — Organization, user lifecycle & authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quản trị company/department/team/user với quyền hiện hành, không có đường tự nâng quyền.

**Architecture:** Policy module tra role và reporting subtree từ DB. Mutation cây/quyền/last-owner khóa company; admin chỉ quản trị hồ sơ thông thường.

**Tech Stack:** TypeScript, Express, Knex/pg, PostgreSQL, Zod, Vitest/Supertest, Playwright; HTML/CSS/JS hiện tại.

**Spec:** [2026-09-19-gwp-app-real-design.md — revision 2](../specs/2026-09-19-gwp-app-real-design.md).

**Prerequisite:** Phase 0 exit gate đã đạt; dùng ActorContext/auth/audit/lockCompany và test fixture của Phase 0.

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

- `server/src/modules/org/`: schema, repository, service, routes.
- `server/src/modules/authorization/`: role và subject policy dùng chung.
- `server/src/modules/users/`: profile/activation/reset/deactivate.
- `admin.html`, `web/admin/`: org/user UI; `server/src/cli/recover-owner.ts`: recovery.
- Migration `0002-organization.ts`; integration/E2E riêng từng chức năng.

## Task sequence

### Task 1.1: Org schema và CRUD/archive

**Files:**

- Create: `server/src/db/migrations/0002-organization.ts`, `server/src/modules/org/{schema,repository,service,routes}.ts`, `tests/integration/org.test.ts`
- Modify: `server/src/app.ts`, `server/openapi.yaml`

**Interfaces:**

- `createDepartment(actor,{name}): Promise<{id,name}>`; `createTeam(actor,{departmentId,name})`.
- `updateCompany(actor,{name,timezone})`; `archiveOrgUnit(actor,kind,id)`; list theo company có cursor/limit.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/org.test.ts`. Owner/admin CRUD; member 403; department mismatch; archive referenced 409; tạo company thứ hai không endpoint.

```ts
const dep = await f.api("admin").post("/api/v1/departments").send({name:"Vận hành"});
expect(dep.status).toBe(201);
expect((await f.api("member").post("/api/v1/departments").send({name:"Sai"})).status).toBe(403);
expect((await f.api("owner").post("/api/v1/companies").send({name:"Second"})).status).toBe(404);
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/org.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Composite unique(company_id,id) và composite FK cho org/user, reject assigning team không khớp department. Tạo profile.company PATCH chỉ owner/admin, timezone IANA hợp lệ. Archive referenced yêu cầu transfer trước, không cascade. Strict input reject role/managerId trên generic profile API; pagination default25/max100.

```sql
ALTER TABLE department ADD CONSTRAINT department_company_id_unique UNIQUE(company_id,id);
ALTER TABLE team ADD CONSTRAINT team_department_company_fk
  FOREIGN KEY(company_id,department_id) REFERENCES department(company_id,id);
-- Khi archive:
SELECT id FROM app_user WHERE company_id=$1 AND department_id=$2 LIMIT 1;
-- Có reference: 409 ORG_UNIT_IN_USE; không DELETE CASCADE.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/org.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/db/migrations/0002-organization.ts server/src/modules/org server/src/app.ts server/openapi.yaml tests/integration/org.test.ts
git commit -m "feat: add scoped organization CRUD and archive"
```

### Task 1.2: Subject policy và reporting tree chống vòng lặp

**Files:**

- Create: `server/src/modules/authorization/{policy,repository}.ts`, `server/src/modules/org/reporting.service.ts`, `tests/integration/policy.test.ts`
- Modify: `server/src/modules/org/routes.ts`, `server/openapi.yaml`, `tests/helpers/fixture.ts`

**Interfaces:**

- `canAccessSubject(actor,subjectUserId,tx?): Promise<boolean>` (owner/self/manager subtree).
- `assertSubjectAccess(actor,subjectUserId,tx?): Promise<void>` → 404.
- `scopeSubjectIds(actor,tx?): Promise<string[]>`; `setManager(actor,userId,managerId|null)` → owner only.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/policy.test.ts`. Ma trận 5 personas, current subtree, đổi manager revoke ngay, admin không tự nối cây, self/cycle/cross-company; hai update đồng thời tạo cycle chỉ một thành công.

```ts
await expect(policy.assertSubjectAccess(f.actor("admin"),f.ids.member))
  .rejects.toMatchObject({status:404});
const r = await f.api("admin").put("/api/v1/users/"+f.ids.member+"/manager")
  .send({managerId:f.ids.admin});
expect(r.status).toBe(403);
expect(await policy.canAccessSubject(f.actor("member"),f.ids.member)).toBe(true);
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/policy.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Policy factory createPolicy(db) export 3 methods. CTE recursive có visited path để an toàn dữ liệu bẩn. Owner checks current roles không token. setManager khóa company trước kiểm tra descendants và update; cùng company/active. Tất cả subject access require active actor; admin read org metadata không gọi content policy như bypass.

```sql
WITH RECURSIVE descendants AS (
 SELECT id, ARRAY[id] AS visited FROM app_user WHERE id=$1 AND company_id=$2
 UNION ALL
 SELECT u.id, d.visited || u.id FROM app_user u
 JOIN descendants d ON u.manager_id=d.id
 WHERE u.company_id=$2 AND NOT u.id=ANY(d.visited)
)
SELECT id FROM descendants;
-- Chỉ dùng subtree nếu actor có role manager; self được kiểm riêng.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/policy.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/modules/authorization server/src/modules/org tests/integration/policy.test.ts tests/helpers/fixture.ts server/openapi.yaml
git commit -m "feat: enforce current reporting-tree authorization"
```

### Task 1.3: Role assignment, last owner và deactivate

**Files:**

- Create: `server/src/modules/users/{service,repository,schema,routes}.ts`, `tests/integration/user-roles.test.ts`
- Modify: `server/src/app.ts`, `server/openapi.yaml`

**Interfaces:**

- `setRoles(actor,userId,roles: Role[])`; `deactivateUser(actor,userId,{replacementManagerId?})`.
- `createPendingUser(actor,{email,name,title,departmentId?,teamId?})`; `updateProfile` không login identity/role/manager của người khác cho admin.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/user-roles.test.ts`. Admin tạo pending member nhưng không owner; owner cuối bị 409 kể cả song song; manager inactive cần chuyển cấp dưới; revoked session 401.

```ts
expect((await f.api("admin").put("/api/v1/users/"+f.ids.admin+"/roles")
 .send({roles:["owner"]})).status).toBe(403);
expect((await f.api("owner").put("/api/v1/users/"+f.ids.owner+"/roles")
 .send({roles:["member"]})).status).toBe(409);
const user = await f.api("admin").post("/api/v1/users")
 .send({email:"new@example.test",name:"Mới",title:"Staff"});
expect(user.body).toMatchObject({status:"pending",roles:["member"]});
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/user-roles.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Roles allowlist union additive. Under company lock count active owners before removing/deactivating; include active status change. Admin cannot edit privileged owner/admin or credentials/email khác, deactivate manager có reports trả403. Owner transfer reports hoặc null trong cùng transaction; revoke sessions, audit và update atomically. Archive user giữ historical FK.

```ts
await db.transaction(async tx => {
  await lockCompany(tx, actor.companyId);
  const roles = await tx("user_role").join("role","role.id","user_role.role_id")
    .where("user_role.user_id",actor.userId).select("role.key");
  if (!roles.some(r=>r.key==="owner"))
    throw new AppError(403,"OWNER_REQUIRED","Chỉ owner được đổi quyền");
  // Đọc lại target/active owners dưới lock; nếu còn 0 owner thì 409 LAST_OWNER.
  // Apply roles + audit trong tx, không dựa trên roles truyền từ client.
});
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/user-roles.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/modules/users server/src/app.ts server/openapi.yaml tests/integration/user-roles.test.ts
git commit -m "feat: protect role changes and user deactivation"
```

### Task 1.4: Activation/reset tokens và owner recovery

**Files:**

- Create: `server/src/db/migrations/0003-one-time-token.ts`, `server/src/modules/users/credentials.service.ts`, `server/src/cli/recover-owner.ts`, `tests/integration/credentials.test.ts`
- Modify: `server/src/modules/users/routes.ts`, `server/src/modules/auth/routes.ts`, `server/openapi.yaml`

**Interfaces:**

- `issueCredentialToken(actor,userId,purpose:'activate'|'reset'): Promise<{token,expiresAt}>`, owner only.
- `consumeCredentialToken(raw,password): Promise<void>`; `changeOwnPassword(actor,current,next)`.
- CLI `npm run owner:recover -- --email <email>` local prompt/explicit confirmation, no public bypass.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/credentials.test.ts`. Hash-only DB; TTL24h; consumed token reuse; actor admin 403; password change revokes all sessions; CLI wrong DB/mode refused.

```ts
expect((await f.api("admin").post("/api/v1/users/"+f.ids.member+"/credential-token")
 .send({purpose:"reset"})).status).toBe(403);
const r=await f.api("owner").post("/api/v1/users/"+f.ids.member+"/credential-token").send({purpose:"reset"});
const use=()=>f.api().post("/api/v1/auth/reset").send({token:r.body.token,password:"new-long-password-2026!"});
expect((await use()).status).toBe(204);
expect((await use()).status).toBe(400);
expect(JSON.stringify(await f.db("one_time_token").select("*"))).not.toContain(r.body.token);
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/credentials.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

CSPRNG256-bit, SHA256 hash, purpose enum, 24h TTL, used_at locked in transaction. Owner thấy token chỉ lần phát, giao người dùng qua kênh nội bộ; admin không thấy. Reset/activation không tự đăng nhập. CLI dùng stdin password không argv/history, xác nhận deployment ID/email, hash Argon2id, revoke sessions/audit. Thêm package script owner:recover. Rate limit consume routes, constant error cho invalid/expired/used.

```sql
SELECT * FROM one_time_token WHERE token_hash=$1 FOR UPDATE;
-- Kiểm purpose, expires_at > now(), used_at IS NULL và target company.
UPDATE one_time_token SET used_at=now() WHERE id=$1;
UPDATE app_user SET password_hash=$2, status='active', auth_version=auth_version+1 WHERE id=$3;
UPDATE auth_session SET revoked_at=now() WHERE user_id=$3 AND revoked_at IS NULL;
-- Cả ba UPDATE và audit cùng transaction; chỉ hash Argon2 ngoài tx.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/credentials.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/db/migrations/0003-one-time-token.ts server/src/modules/users server/src/modules/auth/routes.ts server/src/cli tests/integration/credentials.test.ts server/openapi.yaml package.json
git commit -m "feat: add one-time activation and audited credential recovery"
```

### Task 1.5: Admin UI, branding và audit metadata

**Files:**

- Create: `admin.html`, `web/admin/{org,users,audit}.js`, `web/activate.js`, `activate.html`, `tests/e2e/admin.spec.ts`
- Create: `server/src/modules/settings/{service,routes}.ts`, `tests/integration/settings.test.ts`
- Modify: `server/src/modules/audit/service.ts`, `scripts/build-public.ts`, `server/src/app.ts`, `server/openapi.yaml`

**Interfaces:**

- GET/PATCH /settings/branding: {displayName,accentColor}; không tùy ý HTML/URL.
- GET /audit: metadata-only paginated; admin redact nội dung/identity nhạy cảm theo schema.
- UI owner-only roles/reporting/token buttons; API remains authoritative.

- [ ] **Step 1: Viết test đỏ** trong `tests/e2e/admin.spec.ts`. Tạo org/pending user→owner activation→user login; admin không có role/reset buttons; trực tiếp API vẫn403; branding escaped.

```ts
await loginAs(page,"admin");
await page.goto("/admin.html");
await expect(page.getByRole("button",{name:"Cấp quyền owner"})).toHaveCount(0);
await page.getByRole("button",{name:"Tạo phòng ban"}).click();
await page.getByLabel("Tên phòng ban").fill("Khối mới");
await page.getByRole("button",{name:"Lưu",exact:true}).click();
await expect(page.getByText("Khối mới",{exact:true})).toBeVisible();
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm run test:e2e -- tests/e2e/admin.spec.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Tạo tests/helpers/browser.ts export loginAs(page,persona) qua login form từ fixture credentials, dùng trong E2E. Tách profile, reporting, roles forms để generic PATCH không vô tình ghi quyền. Activation nhập token/password, không query token vào analytics/log. Org archive hiển thị referenced error hướng dẫn transfer. Audit only metadata, branding zod regex #hex, textContent render. Không expose demo toggle.

```ts
const BrandingInput = z.object({
  displayName:z.string().trim().min(1).max(120),
  accentColor:z.string().regex(/^#[0-9a-fA-F]{6}$/)
}).strict();
// GET/PATCH branding dùng current actor + require admin/owner.
// GET audit chỉ safe_metadata allowlist, không serialize toàn DB row.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm run test:e2e -- tests/e2e/admin.spec.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add admin.html activate.html web/admin web/activate.js tests/e2e/admin.spec.ts tests/helpers/browser.ts server/src/modules/settings tests/integration/settings.test.ts server/src/modules/audit scripts/build-public.ts server/src/app.ts server/openapi.yaml
git commit -m "feat: add organization administration and safe audit viewer"
```

## Exit gate và bằng chứng bàn giao

- [ ] `npm test -- tests/integration`, `npm run typecheck`, `npm run test:e2e -- tests/e2e/admin.spec.ts` PASS.
- [ ] Test races cây/last owner bằng 2 connections PostgreSQL thực, không Promise chỉ trên mock.
- [ ] Thử deactivate/reset khiến session cũ ngừng hoạt động; admin không self-escalation.
- [ ] Ghi `docs/superpowers/evidence/phase-1.md`; review trước Phase 2.

## Self-review coverage

Spec §3 org constraints: Task1/2; §4 permission matrix: Task2/3/5; §8 account lifecycle: Task3/4; §9 audit/branding: Task5. Content canvas policy thực tế nối ở Phase2, không hứa canvas endpoints tại phase này.
