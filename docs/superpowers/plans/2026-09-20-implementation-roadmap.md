# Roadmap triển khai — spec revision 2

Ngày: 2026-09-20. Trạng thái: kế hoạch, chưa triển khai.
Yêu cầu tạo plans được hiểu là duyệt dùng spec revision 2 làm baseline.
Không sử dụng code block trong plan ngày 2026-09-19.

## Thứ tự và tài liệu

| Phase | Plan | Bàn giao |
|---|---|---|
| 0 | [Foundation](2026-09-20-phase-0-foundation.md) | Auth, PostgreSQL, bootstrap, Compose |
| 1 | [Organization & authorization](2026-09-20-phase-1-org-authorization.md) | Tổ chức, user lifecycle, policy |
| 2 | [Canvas & pilot](2026-09-20-phase-2-canvas-pilot.md) | Editor, version, dashboard, export |
| 3 | [Local AI BYOK](2026-09-20-phase-3-local-ai-byok.md) | Renderer, Coach, preview |
| 4 | [Reports & delivery](2026-09-20-phase-4-reports-delivery.md) | Grader, report ACL, vận hành, bàn giao |

Chạy 0 → 1 → 2 → 3 → 4; không thực thi song song các phase phụ thuộc.
Mỗi phase kết thúc bằng test evidence và review checkpoint. Các task có thể chia thành
nhiều lượt RED/GREEN ngắn; không commit implementation khi test của task còn fail.
Nếu contract đã triển khai ở phase trước khác plan, cập nhật plan cùng tests trước khi
đi tiếp; không tạo interface thứ hai cùng chức năng.

## Repository baseline

Hiện tại chỉ có demo tĩnh, chưa có package.json/backend/test runner. Những đường dẫn
server/tests/web dưới đây là file sẽ tạo, không phải code đã tồn tại.
Giữ root HTML làm nguồn UI, build allowlist vào public-build; tuyệt đối không serve root.
Canvas Online hiện dùng goal.statement, kr.current, solution.direction/logic, risks chuỗi.
Demo dùng goal chuỗi, kr.cur, risks mảng và fullVersion() dựng snapshot giả cho brief.
Không dùng fullVersion() để migration lịch sử; không làm mất solution hoặc risks khi port.

## Hợp đồng chia sẻ

Phase 0 tạo server/src/shared/contracts.ts:

```ts
export type Id = string;
export type Role = "owner" | "admin" | "manager" | "member";
export type ActorContext = Readonly<{
  userId: Id; companyId: Id; sessionId: Id; requestId: string;
}>;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Clock = () => Date;
export type AppErrorBody = {
  code: string; message: string; details?: unknown; request_id: string;
};
```

Services tạo bằng factory nhận Knex và Clock; actor không mang cached roles.
Public API response dùng camelCase; SQL dùng snake_case; ngày ISO, timestamp UTC.
Client apiFetch nhận path bắt đầu bằng / (ví dụ /canvases), tự thêm /api/v1 đúng một lần;
path đã có /api/v1 được giữ nguyên. Không nhận URL tuyệt đối để tránh gửi bearer sai host.
Mọi test trong plan dùng Vitest expect và fixture f, trừ task bootstrap harness đầu tiên.
Tất cả endpoint đều có prefix /api/v1 dù ví dụ ghi đầy đủ để tránh nhầm.

### Test harness (Phase 0 Task 1, mở rộng tại task tạo module)

tests/helpers/fixture.ts export:

```ts
import type { Knex } from "knex";
import type { Express } from "express";
import type { ActorContext, Id } from "../../server/src/shared/contracts";
import type { SuperTest, Test } from "supertest";
export type Persona = "owner" | "admin" | "manager" | "member" | "outsider";
export interface Fixture {
  db: Knex;
  maintenanceDb: Knex;
  app: Express;
  ids: Record<Persona, Id> & { company: Id; otherCompany: Id };
  actor(persona: Persona): ActorContext;
  api(persona?: Persona): SuperTest<Test>;
  close(): Promise<void>;
}
export declare function fixture(options?: { seeded?: boolean }): Promise<Fixture>;
```

Implement fixture bằng database test riêng tên gwp_test, schema UUID riêng mỗi test file,
migrations thật, search_path riêng; migrations seed company chỉ khi seeded=true.
Phải kiểm tra tên DB trước thao tác cleanup và chỉ drop schema do fixture tạo.
Không TRUNCATE public/DB dùng chung, không đọc DATABASE_URL production làm fallback.
Phase 0 Task 3–4 thêm seed persona và signed sessions khi auth đã tồn tại.
api(persona) dùng Supertest agent với Bearer test-session và Origin hợp lệ;
api() anonymous. Test auth cookie dùng Supertest agent trực tiếp, không giả token.
outsider là member cùng company nhưng nằm ngoài subtree của manager. otherCompany là UUID
không tồn tại dùng để thử forged company input/FK; không tạo company thứ hai hoặc tháo
singleton constraint để test. Cô lập hai deployment bằng hai fixture/schema khác nhau
khi cần thử token/ID của deployment A trên deployment B.
Fixture seed bằng SQL test-only, không phụ thuộc API CRUD chưa ra đời.
Seed/migrate dùng kết nối migrator riêng rồi đóng; f.db luôn dùng runtime credential để
test quyền SQL thật. f.maintenanceDb chỉ dùng trong test retention/restore và bị đóng bởi close().

Mẫu setup lặp trong mỗi integration file:

```ts
import { beforeEach, afterEach, expect, it } from "vitest";
import { fixture, type Fixture } from "../helpers/fixture";
let f: Fixture;
beforeEach(async () => { f = await fixture({ seeded: true }); });
afterEach(async () => { await f.close(); });
```

### Scripts bắt buộc được tạo ở Phase 0

| Script | Lệnh |
|---|---|
| test | vitest run |
| typecheck | tsc --noEmit |
| build | tsx scripts/build-public.ts && tsc -p tsconfig.build.json |
| dev | tsx watch server/src/index.ts |
| start | node dist/server/src/index.js |
| db:migrate | tsx server/src/db/migrate.ts |
| test:e2e | playwright test |
| ops:backup | tsx scripts/ops/backup.ts |
| ops:restore-test | tsx scripts/ops/restore-test.ts |

Cài dependency và pin exact versions + lockfile khi thực thi Phase 0; xác minh supported
Node LTS/Postgres major trước khi khóa release. Không sao chép version cũ trong plan cũ.
Tài liệu kế hoạch không khẳng định đã test một tổ hợp version chưa cài.

## Checkpoint, testing và phạm vi

- Phase 0 auth kiểm tra inactive session bằng SQL fixture; UI deactivate tới Phase 1.
- Phase 1 policy test dùng subject user ID, chưa cần canvas table.
- Phase 2 lưu schema_version=1; nghiệp vụ vẫn Canvas 3.0. Chính xác field/schema được
  tạo bằng cách trích field thực tế từ editor, có fixture khóa contract trước dịch vụ DB.
- Phase 3 Renderer nhận ghi chú/report text người dùng nhập; tích hợp report ID có ACL
  chỉ bật ở Phase 4. Không tạo dependency ngược yêu cầu report table ở Phase 3.
- Phase 4 không tự huấn luyện/host model. Smoke test AI thật dùng endpoint nội bộ được operator cấp.
- Tests thuần và integration mock HTTP upstream, không mock authorization/repository.
- Test output AI đúng schema không chứng minh rubric/chất lượng: có gate đánh giá mẫu bởi
  người phụ trách nghiệp vụ trên model local mục tiêu.
- Ghi kết quả thực thi vào docs/superpowers/evidence/phase-N.md: commit, commands,
  exit status, test count, QA screenshots, model config đã redacted, limitations.
- Chưa có bằng chứng thì không ghi phase complete hoặc “production-ready”.

## Những quyết định implementation nhất quán

- Một draft/canvas; actor nào có quyền sửa đều có quyền publish.
- Giữ quyền report riêng, shares theo report version, không tự chuyển khi đổi manager.
- Nội dung gốc transcript không lưu; local gateway cũng tắt body logging.
- Permission mutations và protected writes serialize qua khóa company trong transaction
  (đơn giản cho pilot); network AI luôn nằm ngoài transaction.
- Publish/request receipts giữ 7 ngày; retry vẫn kiểm tra quyền, key khác hash trả 409.
- Metadata AI giữ 90 ngày; provenance đã copy vào published report/version không bị mất.
- Admin không được phát mã kích hoạt/reset hoặc thay login identity của người khác.
- Runtime không phụ thuộc Internet; build/dependency download có thể thực hiện ở máy chuẩn bị
  rồi xuất offline bundle, không tự cài dependency trên máy khách.

## Test data setup theo phase (không dùng ID hardcode)

Các block test trong task là assertions trọng tâm, đặt trong it() với imports/setup bên trên.
Biến body/ID phải được khởi tạo như sau, không thay bằng UUID ngẫu nhiên không có bản ghi:

| Biến | Nguồn phải tạo trong task |
|---|---|
| db, config, app, request | Phase0 Task1: createDb(TEST_DATABASE_URL), loadConfig(testEnv), createApp; request import từ supertest |
| policy | Phase1 Task2: createPolicy(f.db) |
| canonicalBody, legacyFull, withMeasurement | Phase2 Task1 fixtures; withMeasurement thêm observed measurement hợp lệ vào canonicalBody |
| canvasId, baseVersionId, capturedRevision | Phase2 Task3/4: POST canvas bằng member; publish nếu cần rồi POST draft từ current version, lấy ID/revision response |
| draftOnlyCanvas | Phase2 Task6: POST canvas nhưng không publish, seed fixture member thuộc manager |
| initialDraft, canvasId, baseVersionId trong web snippet | GET canvas/draft response trong editor initializer; không globals từ data.js |
| localConfig, fakeLlm, adapter | Phase3 Task2: startFakeLlm(), createAdapter(), config trỏ fake server allowlisted; close server ở afterEach |
| runId, preview, capturedVersionId | Phase3 Task3/4: fake server trả canonical.md; POST ai/runs rồi poll metadata tới succeeded trước apply |
| validCoach, parsed | Phase3 Task5: fixture đúng rubric đã port; parsed là kết quả schema.parse(raw) trong validator |
| sessionId, reportId, originalProvenance | Phase4 Task1/2: tạo session manager→member, grader fake đúng rubric, save report; Task1 ACL dùng SQL fixture báo cáo tối thiểu trước grader |
| maintenanceDb | f.maintenanceDb; retention fixtures đặt thời gian cũ bằng kết nối test privileged, không đổi clock production |
| page, loginAs | Playwright test fixtures; import loginAs từ tests/helpers/browser.ts (Phase1 Task5) |

Phase0 test auth tạo fixture account trực tiếp; loginAs helper chỉ bắt đầu được dùng từ
Phase1. Toàn bộ tests/e2e sử dụng fixture DB/setup riêng không kết nối app production.

Gói fixtures của mỗi phase được tạo trong Files của task đầu dùng nó; các test runner không
được bỏ assertion khi thiếu fixture. Integration helpers poll AI phải có timeout (5 giây
cho fake upstream), không sleep vô hạn. Mỗi code path race dùng hai connection độc lập.

## Ma trận độ phủ spec revision 2

| Spec | Task chịu trách nhiệm |
|---|---|
| §1 PostgreSQL-only/local BYOK/single-company | 0.1–0.3, 3.1, 4.6 |
| §2 services/API-first/public boundary/OpenAPI | 0.1, 0.5–0.6; mỗi phase cập nhật OpenAPI |
| §3 schema/constraints/IDs/timezone/receipts | 0.2, 1.1–1.3, 2.1, 2.3–2.4, 2.6 |
| §4 permission matrix/last-owner/admin restrictions | 1.2–1.5, 2.3–2.4, 4.1–4.3 |
| §5 canonical/legacy/import/draft/publish/export/dashboard | 2.1–2.7 |
| §6 sessions/report ACL/transcript/deletion/provenance | 4.1–4.5 |
| §7 BYOK/adapter/consent/limits/errors/3 assistants | 3.1–3.6, 4.2, 4.4 |
| §8 auth/bootstrap/demo/recovery/no-CDN | 0.3–0.6, 1.3–1.5 |
| §9 Docker/audit/retention/backup/keys/restore/upgrade | 0.2, 0.6, 4.5–4.6 |
| §10 phase gates/performance/full journey | Exit gates của cả 5 plan; 4.7 |
| §11 source port/checksum/no absolute runtime paths | 2.1–2.2, 3.4–3.5, 4.2 |
| §12 exclusions | Global Constraints và phạm vi từng plan, không tạo task ngoài phạm vi |

Review tài liệu: đã xác định task cho mọi mục spec; test code trong plan là yêu cầu
cho lượt thực thi, không phải bằng chứng test đã chạy. Duyệt runtime/model versions,
đo benchmark và nghiệm thu AI thật vẫn là các bước thực thi được ghi rõ trong exit gates.
