# Phase 2 — Bằng chứng nghiệm thu

Ngày: 2026-09-21. Branch: `feat/real-app-design`.
Plan: `docs/superpowers/plans/2026-09-20-phase-2-canvas-pilot.md`.
Ledger: `.superpowers/sdd/2026-09-20-phase-2-canvas/progress.md`
(workspace gitignored).

Commits theo task: 2.1 `7c46c8f`+`8e40669`, 2.2 `e19453a`+`733f3c0`+`40064a5`,
2.3 `dec1102`, 2.4 `ac1d93e`+`aca04d8`, 2.5 `01d7880`+`cc45e0a`+`776241b`,
2.6 `6fe8bad`, 2.7 `efef8bc` (export boundary + pilot gate).

## Kết quả kiểm chứng cuối phase (HEAD sau 2.7)

- `npm test` — **300/300** (20 file): unit schema/markdown/measurement/xlsx
  + integration canvas/dashboard/export/audit/org/auth trên PostgreSQL thật.
- `npm run typecheck` — 0 lỗi.
- `npm run build` — `public-build/` 32 file, đúng allowlist.
- `npm run test:e2e` — **20/20** (canvas editor 7 + export 3 + auth/org/…).
- `git diff --check` — sạch.

## Exit gate → bằng chứng

| Gate | Bằng chứng |
|---|---|
| `npm test`, `typecheck`, `build`, canvas E2E PASS | Số liệu trên |
| Snapshot full legacy có golden tests; brief không thành lịch sử giả | `tests/integration/dashboard.test.ts` — seed chỉ import full version; brief → `migration_notes` + `skipped_briefs`, không tạo version giả |
| Concurrent writes, retry publish, import/export không mất field | `canvas.test.ts` 19 race test trên PG thật; publish idempotent qua `write_receipt`; markdown round-trip 35 test |
| Pilot create→manager→export chạy khi AI tắt, Internet chặn | Không dependency ngoài: font bundle local, không CDN, không cloud call; walkthrough `docs/operations/pilot.md` |
| QA PDF/PNG/Excel | `docs/operations/pilot.md` §3 — checklist manual (A4 nhiều trang, dấu tiếng Việt, ô `=…` trong Excel) |

## Các phát hiện đáng nhớ theo task

### 2.1–2.2 (schema + markdown)

- `fromLegacy` từng thảy body không hợp lệ schema lặng lẽ (ISO substring,
  >3 output/>5 hành vi) → fix ở `8e40669`: gate validation + clamp có
  cảnh báo.
- Preamble-exemption trong parser Markdown từng cho smuggle meta/content
  label qua section `##` không nhận diện → fix `40064a5`: meta chỉ đọc
  trước `##` đầu tiên, orphan sau heading báo `UNPARSED_CONTENT`.

### 2.3–2.4 (persistence + CAS/publish)

- `canvas_version` bất biến ở cả mức DB role (không UPDATE/DELETE) —
  kiểm chứng trực tiếp trên PG.
- `write_receipt` từng còn quyền UPDATE surplus → revoke ở `aca04d8`
  (receipt forge-proof).
- Cursor malformed từng 500 thay vì 400 — fix chung cho canvas + audit.
- `canvasDto` `Promise.all` trên tx connection → serialize lại (pg
  deprecation warning).

### 2.5–2.6 (editor + dashboard)

- `model.js` từng chứa NUL byte thật (escape sentinel `\|`) → file bị coi
  là binary; fix bằng `"\u0000"` escape (`776241b`).
- `localStorage` hoàn toàn bị loại khỏi runtime — chỉ còn để phát hiện
  draft legacy và import có xác nhận.
- Dashboard không bao giờ đếm draft làm bằng chứng; canvas chưa chốt chỉ
  báo status; archived ngừng nagging; ngày công ty tính theo
  `Asia/Ho_Chi_Minh`; series chỉ từ `observed[].measurement`, metric đổi
  unit/revision tách series mới.

### 2.7 (export boundary)

- Hai endpoint audited: `GET .../versions/:id/export?format=` (snapshot
  bất biến; JSON verbatim, Markdown kèm `warnings` mất dữ liệu) và
  `POST .../export-preview` (draft hiện tại + revision + warnings; 404 sau
  khi publish consume draft).
- Audit metadata chỉ `{mode, version}` — nội dung xuất không vào audit
  log (allowlist chặt).
- XLSX inline strings — ô `=…`/`+…`/`-…`/`@…` không thành công thức
  (`canvas-export-xlsx.test.ts`); XML metachar escape đủ.
- Toolbar editor flush autosave trước khi preview-export — file luôn là
  bản đã lưu server, không phải state tab-local.
- `assets/export.js` đánh dấu demo-era, không trang nào nạp, bị loại khỏi
  public-build.

## Review độc lập

Các task 2.1–2.4 có review package riêng trong `.superpowers/sdd/` với
vòng fix/re-review (kết quả: Approved). 2.5–2.7 review trên main thread:
non-negotiables đã kiểm trực tiếp (localStorage cấm, XSS qua previewHtml,
subject policy, immutability, audit metadata-only).

## Giới hạn đã biết / còn mở

- QA PDF/PNG/Excel phần manual (in ấn, dấu Việt, A4 nhiều trang) cần người
  chạy checklist `docs/operations/pilot.md` §3 trên viewer thật — test tự
  động chỉ phủ được escaping/structure.
- Phase 2 chưa có AI (đúng plan — Phase 3 BYOK); `source: "ai"` trong
  draft schema chuẩn bị sẵn nhưng không có writer nào dùng.
