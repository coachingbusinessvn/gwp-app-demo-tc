# Nghiệm thu & pilot chấp nhận — Phase 4 (acceptance gate)

Tài liệu này là **bản ghi nghiệm thu** cho toàn bộ hành trình khách hàng
trên gói self-hosted, gồm tiêu chí chấp nhận, cách chạy, và bằng chứng đo
được. Tham chiếu spec §9/§10, plan Phase 4 task 4.7.

Phạm vi: một môi trường khách hàng tự vận hành — app + PostgreSQL nội bộ,
LLM nội bộ (BYOK), **không phụ thuộc Internet**.

## 1. Hành trình khách hàng (end-to-end journey)

`tests/e2e/journey.spec.ts` chạy trên browser thật (Playwright) với đăng
nhập thật, token thật, API thật — không backdoor. Một lượt chạy phủ:

| # | Bước | Bằng chứng trong test |
|---|------|------------------------|
| 1 | Admin tạo tài khoản `pending` qua form admin | user xuất hiện trong danh sách |
| 2 | Owner phát mã kích hoạt + cấu hình AI (BYOK loopback) | `POST /users/:id/credential-token` 201, `PUT /settings/ai` 200 |
| 3 | Member kích hoạt trên trang công khai → đăng nhập | dashboard hiện "Canvas cá nhân", **không** có link "Quản trị" |
| 4 | Owner gán member vào tuyến báo cáo của manager | `PUT /users/:id/manager` 200 (chỉ sau khi active — `USER_NOT_ACTIVE` chặn pending) |
| 5 | Member tạo canvas → sửa → **Chốt phiên bản** | badge `v1` |
| 6 | Manager mở canvas của member (subtree) → chạy Renderer AI → áp dụng → chốt | badge `v2`; `currentVersion.versionNo === 2` |
| 7 | Manager tạo phiên coaching → transcript → consent → chấm ORACLE → lưu | report detail hiển thị điểm, transcript không lưu |
| 8 | Share report cho coachee → đọc → revoke | trước share 404 → sau share 200 → sau revoke 404 |
| 9 | Ranh giới quyền | outsider: 404 đồng nhất cho canvas/report/version-export; member: 403 cho `PUT /users/:id/roles` và `GET /audit` |
| 10 | Air-gap: chặn mọi request không phải loopback | dashboard + API vẫn hoạt động; fake LLM trên `127.0.0.1` đã phục vụ cả Renderer lẫn ORACLE |

Chạy: `npm run test:e2e -- tests/e2e/journey.spec.ts`

## 2. Ma trận quyền (đã kiểm)

| Hành động | owner | admin | manager | member | outsider (ngoài subtree) |
|-----------|:-----:|:-----:|:-------:|:------:|:------------------------:|
| Đổi tuyến báo cáo | ✓ | — | — | — | — |
| Phát mã kích hoạt/reset | ✓ | — | — | — | — |
| Cấu hình AI (`/settings/ai`) | ✓ | — | — | — | — |
| Đọc audit log (`GET /audit`) | ✓ | ✓ | — | — | — |
| Đọc/ghi canvas của subordinate | ✓ | — | ✓ (subtree) | — (chỉ của mình) | — |
| Tạo phiên coaching | ✓ | — | ✓ | — | — |
| Lưu/quản report | owner hoặc coach-of-record | | | | |
| Share report | owner hoặc coach-of-record | | | | — (sharee không re-share) |
| Đọc report đã share | — | — | — | ✓ (đúng version được share) | — |

Quy tắc ẩn danh: mọi tài nguyên ngoài phạm vi trả **404 đồng nhất**
(không phân biệt "không tồn tại" và "không có quyền"). UI chỉ là tiện
ích — API là nguồn phán quyết duy nhất (member không thấy link Quản trị
nhưng `PUT /users/:id/roles` vẫn 403 dù gọi trực tiếp).

## 3. Offline / air-gap

- Runtime không phụ thuộc CDN: font bundle trong `assets/fonts/`, script
  `script-src 'self'`, không fetch ra ngoài.
- Journey test chặn **mọi** request có host ≠ `localhost`/`127.0.0.1` —
  trang dashboard, API, và luồng AI đều hoạt động bình thường.
- LLM chỉ đi qua `AI_ALLOWED_HOSTS` (loopback/private) — không có fallback
  cloud nào tồn tại trong mã.
- Gói cài offline: `npm run ops:bundle` — manifest `release-manifest.json`
  loại trừ dữ liệu khách, `.env`, secrets, model weights.

## 4. AI nội bộ

- Consent bắt buộc mỗi run; checkbox tự reset sau khi run kết thúc.
- Transcript ORACLE chỉ tồn tại trong bộ nhớ — không ghi DB, không
  `localStorage`, field được xóa khi run xong.
- Output ORACLE được validate server-side trước preview; save là hành
  động tường minh ("Lưu báo cáo").
- Cầu Renderer→report chỉ mang các trường whitelist (khuyến nghị);
  điểm số, nhãn `[Bằng chứng trực tiếp]`, quote transcript không bao giờ
  đi vào prompt Renderer.
- `GET /settings/ai` không bao giờ trả API key plaintext.

## 5. Vòng đời canvas & report

- Draft mutable, revisioned; autosave dùng CAS `expectedRevision` —
  save cũ trên tab stale trả 409, không auto-overwrite.
- Publish idempotent qua write receipt; `canvas_version` bất biến
  (runtime role bị REVOKE UPDATE/DELETE ở DB level).
- Restore tạo draft mới — không bao giờ sửa lịch sử.
- Report ACL độc lập với canvas; share gắn đúng một version; revoke
  chặn ngay request kế tiếp; delete cần cờ confirm.

## 6. Backup / restore / upgrade (bằng chứng task 4.6)

- `tests/ops/recovery.test.ts`: dump `pg_dump -Fc` → restore vào
  `gwp_restore_test` (disposable) → kiểm login, lịch sử canvas, report
  ACL, giải mã envelope key, publish smoke.
- Mục tiêu pilot (không phải SLA): **RPO ≤ 24 giờ** (backup hằng ngày),
  **RTO ≤ 4 giờ** (restore drill đã tự động hóa, đo được trong vài phút
  trên dataset test).
- `npm run ops:upgrade-check`: refuse khi `deployment_state` ở mode khác,
  schema version không nhận diện được (chống blind downgrade), hoặc
  envelope key không giải mã được.
- Migration từ chối schema chứa version lạ — không có downgrade mù.

## 7. Benchmark pilot (`npm run test:performance`)

`tests/performance/pilot.ts` seed schema `pilot_<uuid>` **test-only**
trong `gwp_test` (disposable — guard chặn mọi URL không phải container
test), rồi boot app thật và chạy **50 session đồng thời**:

- Dataset: 501 users · 5.000 canvas · **100.000 versions** · 1 draft/canvas.
- Mỗi session: login thật (argon2id) → mix `GET /dashboard`,
  `GET /canvases?limit=20`, `GET /canvases/:id`, `PUT /draft` (CAS).
- Warmup không tính; **LLM không nằm trong phép đo** (AI là Phase riêng).
- Kết quả: JSON stdout — per-route count/errors/p50/p95/max/bytes + spec
  phần cứng đo.

### Kết quả đo (bằng chứng)

Host: 12 CPU · 32 GiB · Node v26 — đạt/vượt reference (4 vCPU · 8 GiB):

| Route | n | p50 | p95 | max | errors |
|-------|--:|----:|----:|----:|-------:|
| `POST /auth/login` | 50 | 1.515 ms | 2.579 ms | 2.679 ms | 0 |
| `GET /dashboard` | 150 | 45 ms | 76 ms | 86 ms | 0 |
| `GET /canvases?limit=20` | 150 | 41 ms | 71 ms | 88 ms | 0 |
| `GET /canvases/:id` | 150 | 60 ms | 101 ms | 118 ms | 0 |
| `PUT /canvases/:id/draft` | 150 | 112 ms | 160 ms | 177 ms | 0 |

**Gate PASS**: p95 ≤ 500 ms cho mọi API thường, 0 lỗi. Login cao hơn là
**có chủ đích** — argon2id là KDF CPU-bound, 50 verify đồng thời là tải
xác thực thật; login nằm ngoài gate API thường.

Lưu ý phần cứng: gate chỉ áp dụng khi host đạt/vượt reference; trên máy
yếu hơn script báo `REPORTED-ONLY` — không fabricate pass.

## 8. Ngoại lệ đã biết & phê duyệt

- Chất lượng nội dung model LLM thật (không phải fake deterministic) là
  gate **riêng** — xem `docs/evaluation/oracle.md` và
  `docs/evaluation/canvas-ai.md`; benchmark không đo chất lượng.
- PDF print/A4 là checklist manual trong `pilot.md` — không tự động.
- Mọi ngoại lệ khác cần quyết định tường minh của người phê duyệt; không
  được waive ngầm.
