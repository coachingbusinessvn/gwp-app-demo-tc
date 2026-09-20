# Phase 1 — Bằng chứng nghiệm thu

Ngày: 2026-09-20. Branch: `feat/real-app-design`.
Plan: `docs/superpowers/plans/2026-09-20-phase-1-org-authorization.md`.
Commits theo task: 1.1 `073633e`+`98931ff`, 1.2 `19dfd64`, 1.3
`5e64c53`+`87f3d81`, 1.4 `aa8f251`+`5cfad12`, 1.5 xem `git log` cuối.

## Điều kiện nghiệm thu (exit gate của plan)

| Điều kiện | Bằng chứng |
|---|---|
| `npm test` / typecheck / admin e2e | `vitest run`: 144 tests trên PostgreSQL thật (compose.test.yaml @127.0.0.1:54329); `tsc --noEmit` exit 0; `playwright test tests/e2e/admin.spec.ts` 4/4 xanh |
| Race cây/last-owner bằng 2 kết nối PostgreSQL thật | `user-roles.test.ts`: "serializes two concurrent last-owner demotions — exactly one succeeds", "serializes two concurrent owner deactivations — exactly one succeeds"; `policy.test.ts`: "serializes concurrent edits that would form a cycle — exactly one wins" (200+409, loser `REPORTING_CYCLE`); `auth.test.ts`: "concurrent rotation of the same token has exactly one winner". Tất cả trên DB thật, không mock |
| Deactivate/reset giết session cũ; admin không self-escalation | `user-roles.test.ts`: deactivate → session chết; `credentials.test.ts`: reset revoke mọi session, consume không resurrect; admin 403 trên role/deactivate-owner; `auth.test.ts`: deactivate→reactivate không hồi sinh token |
| Admin UI + branding + audit metadata-only | `admin.spec.ts` 4/4: admin quản org không thấy nút owner-only (API vẫn 403), vòng đời pending→activate→login thật, displayName HTML render như text, audit viewer metadata-only |

## Task 1.5 — chi tiết

- Server mới: `GET/PATCH /api/v1/settings/branding` (zod strict
  `{displayName 1–120, accentColor #rrggbb}`; GET mọi active member, PATCH
  owner/admin; audit chỉ ghi `{"key":"branding"}` — không bao giờ giá trị) và
  `GET /api/v1/audit` (owner/admin, keyset cursor, limit 25 mặc định / 100 max,
  DTO metadata-only, re-redact qua `AUDIT_METADATA_ALLOWLIST` khi đọc).
- UI mới: `admin.html` + `web/admin/{http,main,org,users,audit}.js` —
  phòng ban/team CRUD + archive (409 `ORG_UNIT_IN_USE` hiển thị hướng dẫn
  chuyển member trước), user list + tạo pending + sửa hồ sơ + cấp role +
  phát mã + deactivate kèm `replacementManagerId`, tab nhật ký, form
  branding. Nút owner-only (Cấp quyền/Phát mã/Đổi cấp trên) không render
  cho admin. `activate.html` + `web/activate.js`: đọc `?token=` một lần,
  `history.replaceState` xoá khỏi address bar, `?purpose=reset` →
  `/auth/reset`; không localStorage/analytics/console; không tự tạo session.
- Rendering an toàn: mọi dynamic text qua `textContent`/safe DOM; không
  `innerHTML` với dữ liệu động; accentColor qua CSS custom property sau khi
  validate 2 phía.
- `scripts/build-public.ts`: allowlist thêm `admin.html`, `activate.html`,
  `web/activate.js`, `web/admin/*`. OFL.txt bổ sung dòng Playfair Display.
- OpenAPI: paths/schemas mới chỉ cho route tồn tại.

### Lỗi thật phát hiện & sửa trong task này

- **`[hidden]` bị `.btn{display:inline-flex}` đè** (`assets/gwp.css`): rule
  author thắng UA `[hidden]{display:none}` → `<a class="btn" hidden>` vẫn
  hiển thị. Hậu quả: link "Đăng nhập" trên activate.html hiện ngay từ đầu,
  e2e click trước khi consume commit → login trúng lúc user còn `pending`
  → 401 INVALID_CREDENTIALS. Đã thêm `[hidden]{display:none!important}`
  toàn cục (cùng pattern `.tabpanel[hidden]` đã có). Giờ link chỉ hiện sau
  204 thật.
- **Per-IP session limiter 429 trong e2e**: cả suite chạy trên 127.0.0.1 —
  sau khi thêm 4 test admin, refresh/logout vượt 30/phút trong một cửa sổ.
  Fix phía test: `TRUST_PROXY=loopback` trong webServer env +
  `isolateClientIp()` (X-Forwarded-For duy nhất mỗi browser context) — giống
  hình dáng multi-client thật; giới hạn production không đổi.
- Context chia sẻ session: `loginAs` trong cùng context bị index.html
  auto-redirect — test lifecycle dùng `browser.newContext` riêng cho
  owner/public.

## Test suite (task 1.5)

- `npm run test:e2e -- tests/e2e/admin.spec.ts`: **4/4 xanh** (sau fix
  `[hidden]`). RED ban đầu: không capture riêng trước khi implement
  (ghi nhận lệch quy trình — RED chứng kiến gián tiếp qua fail đầu của
  lifecycle test).
- `npm test -- tests/integration/settings.test.ts tests/integration/audit.test.ts`:
  **7/7 xanh**.
- `npm run test:e2e` toàn bộ: **9/9 xanh** (admin 4 + auth 5).
- `npm test` toàn bộ: mọi file xanh; lưu ý flake môi trường đã biết từ
  Phase 0 — dưới chạy song song ngẫu nhiên 1 test timeout/ECONNRESET
  (argon2-nặng + churn kết nối trên host này); mỗi file đều pass khi chạy
  riêng. Trong phiên này còn thấy `EADDRNOTAVAIL` khi chạy lặp lại nhiều
  lần liên tiếp (cạn ephemeral port/TIME_WAIT) — hết sau khi host nghỉ.
- `npm run typecheck`: exit 0. `npm run build`: public-build 24 file.
- `git diff --check`: sạch.

## Giới hạn đã biết (không chặn Phase 1)

- Flake argon2/kết nối trên host dev này (đã ghi ở phase-0.md) — nên cân
  nhắc `--maxWorkers` thấp hơn hoặc pool nhỏ hơn cho fixture trước Phase 2.
- Audit viewer là metadata-only theo thiết kế; drill-down nội dung canvas
  là Phase 2+.
- Branding chỉ displayName + accentColor theo contract an toàn; logo/custom
  CSS chưa nằm trong scope.
