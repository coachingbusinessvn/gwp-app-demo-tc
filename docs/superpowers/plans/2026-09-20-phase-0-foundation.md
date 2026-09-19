# Phase 0 — Foundation, PostgreSQL & real authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chạy app container với PostgreSQL, owner bootstrap và đăng nhập thật, chưa mở nghiệp vụ canvas.

**Architecture:** Express modular monolith; public-build là static allowlist. Auth kiểm tra session DB mỗi request; migrations, audit và Compose có ngay từ đầu.

**Tech Stack:** TypeScript, Express, Knex/pg, PostgreSQL, Zod, Vitest/Supertest, Playwright; HTML/CSS/JS hiện tại.

**Spec:** [2026-09-19-gwp-app-real-design.md — revision 2](../specs/2026-09-19-gwp-app-real-design.md).

**Prerequisite:** Spec revision 2; không thực thi plan Phase 0 ngày 2026-09-19.

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

- `server/src/{app,index,config}.ts`: cấu hình/factory/lifecycle.
- `server/src/db/`: connection, migrations, runner.
- `server/src/modules/{auth,audit}/`: routes/service/repository/schema.
- `server/src/shared/`: contracts, errors, pagination, company-lock.
- `web/{auth,api}.js`, `scripts/build-public.ts`: client và static boundary.
- `tests/{helpers,integration,e2e}/`, `compose.yaml`, `Dockerfile`: test/deploy.

## Task sequence

### Task 0.1: HTTP harness, config và PostgreSQL test isolation

**Files:**

- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `server/src/app.ts`, `server/src/index.ts`, `server/src/config.ts`, `server/src/db/connection.ts`, `server/src/shared/contracts.ts`, `server/src/shared/errors.ts`, `server/src/shared/pagination.ts`
- Create: `tests/helpers/fixture.ts`, `tests/integration/health.test.ts`, `compose.test.yaml`

**Interfaces:**

- `createApp({db, clock, config}): Express`; `createDb(url: string): Knex`.
- `loadConfig(env): Config` từ env đã validate; `AppError(status, code, message, details?)`.
- `fixture()` theo roadmap; health liveness không dùng DB, readiness thử DB và migration version.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/health.test.ts`. Trước tiên dùng createApp trực tiếp; sau khi thêm fixture chạy isolation/readiness 503 và limit body 413.

```ts
const app = createApp({ db, clock: () => new Date("2026-09-20T00:00:00Z"), config });
expect((await request(app).get("/health/live")).status).toBe(200);
expect((await request(app).get("/api/v1/missing")).body).toMatchObject({
  code: "NOT_FOUND", request_id: expect.any(String)
});
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/health.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Cài exact dependencies express/knex/pg/zod/argon2/jsonwebtoken/cookie-parser/helmet và dev TypeScript/Vitest/Supertest/Playwright/tsx/esbuild/types. Tạo scripts roadmap. TypeScript strict + NodeNext, ESM imports có hậu tố .js; rootDir là repo để server/shared cùng compile vào dist. Config bắt buộc DB/secrets/origin; reject weak production secrets. JSON parser 2 MiB; request ID, errors redacted; readiness trả 503 nếu DB/migration chưa đúng. Test fixture xác minh database gwp_test, schema random riêng.

```ts
export function pageLimit(value: unknown): number {
  const n = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100)
    throw new AppError(400, "INVALID_LIMIT", "Giới hạn trang không hợp lệ");
  return n;
}
// Routes không nhận companyId/role để xây ActorContext.
// Đăng ký error handler cuối cùng, sau JSON parser và các routes.
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/health.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .env.example .gitignore server tests compose.test.yaml
git commit -m "feat: bootstrap typed API and isolated PostgreSQL tests"
```

### Task 0.2: Core migrations, audit append-only và company lock

**Files:**

- Create: `server/src/db/migrate.ts`, `server/src/db/migrations/0001-foundation.ts`
- Create: `server/src/modules/audit/service.ts`, `server/src/shared/company-lock.ts`, `tests/integration/foundation-db.test.ts`
- Create: `scripts/ops/bootstrap-db-roles.ts`; script operator tạo migrator/runtime/maintenance, không public API.

**Interfaces:**

- `migrate(db: Knex): Promise<void>`; `lockCompany(tx: Knex.Transaction, companyId: string): Promise<void>`.
- `appendAudit(tx, event: {companyId, actorId?, action, targetId?, outcome, requestId, metadata}): Promise<void>`; metadata strict allowlist.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/foundation-db.test.ts`. Migrations fresh/re-run, unique normalized email, no second company, pending vs active password, runtime role không UPDATE/DELETE audit.

```ts
await expect(f.db("audit_event").update({ action: "tamper" }))
  .rejects.toMatchObject({ code: "42501" });
await expect(f.db("company").insert({ id: crypto.randomUUID(), name: "Second", singleton: true }))
  .rejects.toMatchObject({ code: "23505" });
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/foundation-db.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Tạo company/user/role/user_role/setting/deployment_state/auth_session/refresh_token/audit_event theo spec; department/team tới Phase 1. company.singleton unique CHECK true; outsider cùng company ngoài subtree, không bypass singleton trong tests. Trường email_normalized unique theo company. Tạo runtime/migrator/maintenance roles bằng script operator, grant audit INSERT/SELECT nhưng không UPDATE/DELETE; không test bằng superuser. company lock được mọi mutation quyền và protected write dùng chung.

```sql
CREATE TABLE deployment_state (
  singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
  mode text NOT NULL CHECK (mode IN ('demo','production')),
  setup_completed_at timestamptz,
  seed_version integer NOT NULL DEFAULT 0
);
-- Trong lockCompany(tx, companyId):
SELECT id FROM company WHERE id = $1 FOR UPDATE;
-- Active user phải có password; pending được phép NULL:
ALTER TABLE app_user ADD CONSTRAINT active_password
  CHECK (status <> 'active' OR password_hash IS NOT NULL);
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/foundation-db.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/db server/src/modules/audit server/src/shared/company-lock.ts tests/integration/foundation-db.test.ts scripts/ops/bootstrap-db-roles.ts
git commit -m "feat: add foundation schema and append-only audit"
```

### Task 0.3: Bootstrap owner nguyên tử và demo mode isolation

**Files:**

- Create: `server/src/modules/auth/setup.service.ts`, `server/src/modules/auth/setup.routes.ts`, `server/src/modules/auth/password.ts`
- Create: `server/src/db/seed-demo.ts`, `tests/integration/setup.test.ts`, `tests/fixtures/identities.ts`

**Interfaces:**

- `hashPassword(raw: string): Promise<string>`; `verifyPassword(hash, raw): Promise<boolean>`.
- `setup({bootstrapToken, companyName, email, password}): Promise<{userId, companyId}>`.
- `seedDemo(db, expectedMode: 'demo'): Promise<void>`; no seed production.

- [x] **Step 1: Viết test đỏ** trong `tests/integration/setup.test.ts`. Dùng fixture({seeded:false}); 2 setup request song song, sai token, setup lần hai, restart mode mismatch và seed 2 lần.

```ts
const input = { bootstrapToken: "test-bootstrap", companyName: "GWP",
  email: "owner@example.test", password: "a-long-test-password-123!" };
const results = await Promise.all([1,2].map(() => f.api().post("/api/v1/setup").send(input)));
expect(results.map(r => r.status).sort()).toEqual([201,409]);
expect(await f.db("company").count("* as n").first()).toMatchObject({ n: "1" });
```

- [x] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/setup.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [x] **Step 3: Triển khai phần lõi và nối interface.**

Argon2id benchmark và ghi thông số, setup token constant-time compare. INSERT deployment singleton bằng migration, lock row trước kiểm tra setup_completed_at. Hash trước transaction, tạo company/user/owner role/audit trong transaction, khóa setup sau success. Rate limit setup. Demo chỉ identities tại phase này, UUID mapping l1/p7; canvas seed Phase 2. Fixture mở rộng signed personas khi Task 4 xong, setup test dùng anonymous.

```ts
await db.transaction(async tx => {
  const state = await tx("deployment_state").where({ singleton_id: 1 }).forUpdate().first();
  if (state.setup_completed_at) throw new AppError(409, "SETUP_CLOSED", "Đã thiết lập");
  if (state.mode !== config.mode) throw new AppError(409, "MODE_MISMATCH", "Sai chế độ");
  // Chèn company, app_user và user_role với ID đã sinh; không nhận role từ request.
  // Ghi audit và setup_completed_at trong transaction này, không mở setup lại khi restart.
});
```

- [x] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/setup.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [x] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/modules/auth server/src/db/seed-demo.ts tests/integration/setup.test.ts tests/fixtures/identities.ts
git commit -m "feat: add guarded owner bootstrap and isolated demo seed"
```

### Task 0.4: Login, rotating refresh, logout và revocation

**Files:**

- Create: `server/src/modules/auth/{service,repository,routes,middleware,schema}.ts`
- Modify: `server/src/app.ts`, `tests/helpers/fixture.ts`
- Create: `tests/integration/auth.test.ts`

**Interfaces:**

- `authenticate(access: string): Promise<ActorContext>` kiểm DB mỗi request.
- `login(email,password): Promise<{accessToken, refreshToken, user}>`; `rotate(raw): Promise<{accessToken,refreshToken}>`; `revokeSession(sessionId): Promise<void>`.
- POST auth/login, auth/refresh, auth/logout; GET auth/me; refresh token chỉ Set-Cookie, không JSON.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/auth.test.ts`. Login sai user/password cùng 401; access 10 phút/refresh 7 ngày; reused token revoke family; concurrent rotation một thắng; deactivate SQL fixture khiến access cũ 401; Origin sai bị 403.

```ts
const logged = await request(f.app).post("/api/v1/auth/login")
  .set("Origin","https://gwp.test").send({email:"member@example.test",password:"fixture-password"});
expect(logged.body.refreshToken).toBeUndefined();
expect(logged.headers["set-cookie"].join(";")).toContain("HttpOnly");
await f.db("app_user").where({id:f.ids.member}).update({status:"inactive"});
expect((await request(f.app).get("/api/v1/auth/me")
  .auth(logged.body.accessToken,{type:"bearer"})).status).toBe(401);
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/auth.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Random 256-bit refresh token, chỉ SHA-256 hash; giữ consumed token để detect reuse. Lock token/session, consume và insert replacement nguyên tử. Reuse branch commit revoke trước khi ném 401 ở ngoài transaction (không rollback revocation). Cookie Secure/HttpOnly/SameSite=Strict, path /api/v1/auth. Check Origin và CSRF token cho refresh/logout. JWT issuer/audience/sessionId, không dùng cached role. Rate limit account+IP với trusted proxy cấu hình rõ.

```ts
const outcome = await db.transaction(async tx => {
  const token = await tx("refresh_token").where({token_hash: hash(raw)}).forUpdate().first();
  if (!token) return {kind:"invalid"} as const;
  if (token.consumed_at) {
    await tx("auth_session").where({id:token.session_id}).update({revoked_at:clock()});
    return {kind:"reuse"} as const; // COMMIT, không throw bên trong
  }
  // Kiểm expires/session/user; consume token và insert replacement trong tx.
  return rotateValidToken(tx, token); // private helper cùng file, trả token pair
});
if (outcome.kind !== "ok") throw new AppError(401,"INVALID_SESSION","Phiên không hợp lệ");
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/auth.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Helper rotateValidToken/hash nằm trong repository/service task này, có unit tests không log token.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add server/src/modules/auth server/src/app.ts tests/helpers/fixture.ts tests/integration/auth.test.ts
git commit -m "feat: add revocable authentication and refresh rotation"
```

### Task 0.5: Web auth thật và public asset boundary

**Files:**

- Create: `web/api.js`, `web/auth.js`, `scripts/build-public.ts`, `playwright.config.ts`, `tests/e2e/auth.spec.ts`
- Modify: `index.html`, `assets/app.js`, `dashboard.html`, `employee.html`, `canvas.html`, `server/src/app.ts`
- Create: `tests/integration/static-boundary.test.ts`

**Interfaces:**

- `apiFetch(path, init?): Promise<Response>`; `getAccessToken(): Promise<string>`; `logout(): Promise<void>`.
- Build public allowlist cụ thể; phase này chỉ setup/login/account shell, nghiệp vụ chưa hoàn tất bị disabled.

- [ ] **Step 1: Viết test đỏ** trong `tests/e2e/auth.spec.ts`. Định nghĩa fixture E2E owner bootstrap và hai tab cùng cookie; browser refresh đồng thời không revoke nhầm; không token/localStorage, production không tải assets/data.js.

```ts
await page.goto("/index.html");
await page.getByLabel("Email").fill("member@example.test");
await page.getByLabel("Mật khẩu",{exact:true}).fill("fixture-password");
await page.getByRole("button",{name:"Đăng nhập",exact:true}).click();
await expect(page.getByTestId("account-name")).toBeVisible();
expect(await page.evaluate(() => Object.keys(localStorage))).not.toContain("gwp-demo-tc-session");
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm run test:e2e -- tests/e2e/auth.spec.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Login form thật thay chọn vai trò. Chuyển requireSession thành async identity API; xóa dereference PEOPLE[me.id]. apiFetch thêm bearer, chỉ retry 401 một lần. Refresh dùng navigator.locks theo origin + BroadcastChannel chia sẻ access token trong memory giữa tabs; fallback browser unsupported hiển thị yêu cầu browser hỗ trợ, không lưu token disk. Build chỉ copy UI đã chuyển đổi, fonts bundle local có license; dùng esbuild bundle web entrypoints và shared/canvas TypeScript (khi Phase2 tạo) thành ESM browser, không serve source TS. Không public fixtures/docs/server. Root GitHub Pages demo không phải production target; không fallback về fake auth khi API lỗi.

```ts
app.use(express.static(config.publicDir, { dotfiles: "deny", index: false }));
// config.publicDir luôn là public-build, tuyệt đối không cwd/repository root.
// Kiểm tra boundary bằng Supertest:
for (const path of ["/.env","/server/src/config.ts","/docs/superpowers/specs/2026-09-19-gwp-app-real-design.md","/assets/data.js"])
  expect((await request(app).get(path)).status).toBe(404);
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm run test:e2e -- tests/e2e/auth.spec.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add web scripts/build-public.ts playwright.config.ts tests/e2e/auth.spec.ts tests/integration/static-boundary.test.ts index.html assets/app.js dashboard.html employee.html canvas.html server/src/app.ts
git commit -m "feat: integrate real web login and allowlisted static assets"
```

### Task 0.6: Compose, OpenAPI, health và backup smoke test

**Files:**

- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`, `server/openapi.yaml`, `scripts/ops/{backup,restore-test}.ts`, `docs/operations/foundation.md`
- Create: `tests/integration/deployment.test.ts`
- Modify: `package.json`, `server/src/index.ts`

**Interfaces:**

- `/health/live`, `/health/ready`, `/api/v1/openapi.json` (spec không secrets).
- `ops:backup -- --output <operator-path>` tạo custom-format dump; `ops:restore-test -- --backup <file>` chỉ restore DB test xác nhận tên.

- [ ] **Step 1: Viết test đỏ** trong `tests/integration/deployment.test.ts`. Compose config hợp lệ, DB không publish host port, public artifact không secret, readiness DB down 503 nhưng live 200; migration rerun; restore health bằng test DB.

```ts
expect((await f.api().get("/health/live")).status).toBe(200);
const spec = (await f.api().get("/api/v1/openapi.json")).body;
expect(spec.paths["/api/v1/auth/login"].post).toBeDefined();
expect(JSON.stringify(spec)).not.toContain("fixture-password");
```

- [ ] **Step 2: Chạy test trước triển khai.**

Run: `npm test -- tests/integration/deployment.test.ts`.
Expected: FAIL tại hành vi/assertion mới hoặc missing module; sửa lỗi setup/môi trường trước,
không coi lỗi không kết nối DB là bằng chứng RED hợp lệ.

- [ ] **Step 3: Triển khai phần lõi và nối interface.**

Multi-stage build non-root, app/postgres volumes tách, DB healthcheck và one-shot migrator trước app. Pin runtime/image tại execution, commit digest/lock. graceful SIGTERM stop new requests/drain server/disconnect DB. backup dùng spawn với argv, pg_dump -Fc, không log DATABASE_URL; restore dùng pg_restore --exit-on-error vào gwp_restore_test mới tạo, không production. Foundation runbook TLS/bootstrap/env/demo và evidence smoke.

```sh
docker compose config --quiet
docker compose up -d --build
npm run db:migrate
npm run ops:backup -- --output /tmp/gwp-foundation.dump
npm run ops:restore-test -- --backup /tmp/gwp-foundation.dump
docker compose restart app
# Không chạy down -v trên DB khách; test persistence qua account đã tạo.
```

- [ ] **Step 4: Chạy lại test và kiểm tra hồi quy.**

Run: `npm test -- tests/integration/deployment.test.ts`, rồi `npm run typecheck`.
Expected: test mới PASS, typecheck exit 0. Chạy thêm toàn bộ integration tests của module vừa thay đổi.

- [ ] **Step 5: Commit riêng task sau khi kiểm tra diff.**

```sh
git diff --check
git add Dockerfile .dockerignore compose.yaml server/openapi.yaml scripts/ops docs/operations/foundation.md tests/integration/deployment.test.ts package.json server/src/index.ts
git commit -m "feat: ship foundation compose bundle and recovery smoke test"
```

## Exit gate và bằng chứng bàn giao

- [ ] `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e` PASS trên PostgreSQL thật.
- [ ] `docker compose config --quiet`, bootstrap race, refresh reuse và static boundary có evidence.
- [ ] Restore smoke thành công, restart giữ owner; demo/prod không chung volume/secrets.
- [ ] Ghi `docs/superpowers/evidence/phase-0.md`; chỉ chuyển Phase 1 sau review.
- [ ] Không báo canvas hoạt động: account shell là phạm vi phase này.

## Self-review coverage

Spec §2/§3: Tasks 1–2; §8 auth/bootstrap/demo: Tasks 3–5; §9 packaging/audit/backup: Tasks 2/6; §10 Phase 0 gate: tất cả. UI org/deactivation do Phase 1; kiểm tra inactive auth ở đây dùng SQL fixture.
