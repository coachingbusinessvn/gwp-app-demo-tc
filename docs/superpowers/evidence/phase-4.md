# Phase 4 — Bằng chứng nghiệm thu (Reports & delivery)

Ngày: 2026-09-21. Branch: `feat/real-app-design`.
Plan: `docs/superpowers/plans/2026-09-20-phase-4-reports-delivery.md`.

Commits theo task: 4.1 `e93e8a0`, 4.2 `7a51d86`, 4.3 `282c64c`,
4.4 `4aa5b06`, 4.5 `514b9d9`, 4.6 `8d121b4`, 4.7 `489cd79`.

## Kết quả kiểm chứng cuối phase (HEAD `489cd79`)

- `npm test` — **407/407** (34 file): unit + integration + ops recovery
  trên PostgreSQL thật.
- `npx playwright test` — **29/29**, gồm `tests/e2e/journey.spec.ts`
  (journey 10 bước, 5 browser context riêng biệt).
- `npm run test:performance` — **PASS**: 501 users / 5.000 canvas /
  100.000 versions, 50 session đồng thời, 650 request, 0 lỗi;
  p95 API thường ≤ 160 ms trên host 12 CPU/32 GiB (≥ reference
  4 vCPU/8 GiB). Login p95 2,6 s là argon2id có chủ đích — nằm ngoài
  gate API thường.
- `npm run typecheck` — 0 lỗi. `npm run build` — `public-build/` 42 file.
- `docker compose config` — hợp lệ. `git diff --check` — sạch.
- `npm run ops:bundle -- --no-images` — bundle offline sinh đủ artifact,
  mọi checksum SHA256 verify OK.

## Exit gate → bằng chứng

| Gate | Bằng chứng |
|---|---|
| All unit/integration/browser + typecheck/build/compose PASS | Số liệu trên |
| Local model quality tách riêng khỏi fake-LLM | **BLOCKED — chờ operator**: `docs/evaluation/oracle.md` + `docs/evaluation/canvas-ai.md` có checklist fixture; cần endpoint local thật được duyệt. Không khẳng định chất lượng đạt |
| Không raw transcript/key trong DB/logs/browser | `ai-runs.test.ts` (notes/output vắng mặt trong DB — truy vấn trực tiếp); `coaching.spec.ts` (`localStorage.length === 0`, transcript field xóa sau run); `retention.test.ts` (rotate-key không emit material); audit chỉ metadata |
| Report ACL/revocation end-to-end | `report-sharing.test.ts` 4/4 + `journey.spec.ts` (404 → share → 200 → revoke → 404) + `coaching.spec.ts` (confirmed delete, row biến mất) |
| Clean-host restore + upgrade rehearsal; RPO/RTO đo được | `tests/ops/recovery.test.ts` 3/3 (dump -Fc → restore `gwp_restore_test` → login/canvas history/report ACL/key decrypt/publish); `ops:upgrade-check` + downgrade guard (`SCHEMA_AHEAD_OF_CODE`); restore drill hoàn tất trong vài phút trên dataset test — RPO ≤ 24h / RTO ≤ 4h là mục tiêu pilot |
| Offline runtime + pilot benchmark đo được | `checkOfflineRuntime` quét đúng build allowlist (0 external load — đã sửa Google-Fonts CDN); journey air-gap chặn mọi request ≠ loopback mà app vẫn chạy; benchmark PASS ở trên — phần cứng pilot chưa đo (ngoại lệ 3) |
| `phase-4.md` + runbook tiếng Việt được duyệt trước bàn giao | File này + `docs/operations/{deployment-vn,recovery,upgrade,security-retention,acceptance}.md` — **chờ người phê duyệt** |

## Các phát hiện đáng nhớ theo task

### 4.1 (schema + ACL)

- `coaching_session`/`coaching_report`/`report_share`: ACL report độc
  lập canvas — report không kế thừa quyền canvas, sharee không re-share,
  quản lý chỉ owner hoặc coach-of-record (sống sót khi tuyến báo cáo đổi).

### 4.2 (ORACLE grader)

- Transcript ephemeral: chỉ trong request/run, validate server-side,
  preview TTL, save tường minh. `ai_run.canvas_id` nullable cho oracle;
  `ai_run_target_check` nhận `session_id`.

### 4.3 (share/revoke/delete + bridge)

- Share gắn đúng `report_version`; revoke chặn request kế tiếp; delete
  cần confirm + receipt không hồi sinh được. Bridge Renderer chỉ mang
  trường whitelist (`Ưu tiên cải thiện`) — điểm, nhãn bằng chứng, quote
  không qua prompt.

### 4.4 (UI + eval)

- `/coaching-report/` phục vụ qua route tường minh (static `index:false`
  giữ nguyên); bootstrap trong `web/coaching/boot.js` vì CSP
  `script-src 'self'`. Coachee nằm trong share-picker (họ không có quyền
  ngầm — share là cách duy nhất họ đọc report).

### 4.5 (retention + rotation)

- Retention job advisory-locked, batch 1000, floors `max(default,
  configured)` — owner chỉ tăng không giảm. `gwp_maintenance` role riêng
  với DELETE trên audit_event/ai_run/write_receipt/token tables.
- APP_KEY rotation một transaction: decrypt toàn bộ envelope → rewrite →
  re-decrypt proof trước commit; corrupt row → abort nguyên giao dịch.
- Compose: retention one-shot service + local log driver bounds.

### 4.6 (backup/restore + offline + upgrade)

- Drill: `pg_dump -Fc` theo schema → `gwp_restore_test` disposable →
  post-checks (roles, login, canvas history, report ACL, key decrypt,
  publish). `--i-understand` bắt buộc cho target không disposable.
- Downgrade guard ở cả migrate() (throw on unknown applied) lẫn
  `/health/ready` (503 SCHEMA_AHEAD_OF_CODE).
- Bundle chỉ đóng từ `release-manifest.json` curated list — secrets/
  customer data/model weights loại trừ bằng cấu trúc.
- **Fix thật**: Google-Fonts CDN trong 2 trang app → `/assets/fonts.css`.

### 4.7 (journey + benchmark)

- `setManager` yêu cầu subject `active` — gán tuyến báo cáo sau khi
  activate (journey ghi nhận thứ tự này).
- Air-gap test chặn `context.route("**/*")` với mọi host ≠ loopback —
  font/CDN bất kỳ sẽ phá vỡ trang; fake LLM loopback phục vụ cả hai
  đường AI dưới cùng rule.
- Perf gate trung thực: chỉ ghi PASS khi host đạt reference; khác phần
  cứng → REPORTED-ONLY, không fabricate.

## Ngoại lệ còn mở (cần quyết định người duyệt — không tự waive)

1. **Chất lượng model local thật**: fake-LLM deterministic chứng minh
   plumbing; chất lượng ORACLE/Renderer/Coach trên model thật cần chạy
   checklist `docs/evaluation/*.md` trên endpoint operator duyệt.
2. **PDF print/A4**: checklist manual trong `docs/operations/pilot.md`.
3. **Benchmark trên host khách hàng thật**: số liệu hiện có đo trên
   12 CPU/32 GiB; pilot site cần chạy lại `npm run test:performance`
   trên phần cứng triển khai.
4. **Restore sạch + rehearsal nâng cấp Phase3→4; RPO/RTO đo thực**:
   drill hiện restore vào `gwp_restore_test` cùng PG, chưa rehearsal
   nâng cấp, RPO ≤ 24h / RTO ≤ 4h mới là mục tiêu.

## Kiểm chứng lại trên main 2026-10-07

HEAD `9742bfd` (`main`). Gate do worker Codex (gpt-6-astra) chạy trên
host dev 32 CPU / 30 GiB, Node v24.21.0; PostgreSQL test từ
`compose.test.yaml`.

- `npm test` — lượt đầu **452/454** (41 file): 2 fail do tiến trình
  thiếu docker group (`/var/run/docker.sock` permission denied khi
  pg_dump) — môi trường, không phải flake. Chạy lại dưới `sg docker`:
  `tests/ops/recovery.test.ts` 3/3, `tests/integration/deployment.test.ts`
  10/10 → hiệu dụng **454/454**. Lưu ý: test backup/restore cần docker
  group trong session.
- `npm run test:e2e` — **48/48**, không flaky (~1,8 phút).
- `npm run typecheck` — 0 lỗi. `npm run build` — 48 file.
- `docker compose config -q` — hợp lệ (chỉ warning biến env chưa set,
  expected khi không có `.env`).
- `git diff --check` — sạch.
- `npm run test:performance` — **PASS**: 800 request, 0 lỗi, 50
  session; seed 501 users / 5.000 canvas / 100.000 versions; p95: GET
  canvas 70,3 ms, list 49 ms, dashboard 60,5 ms, PUT draft 161 ms (login
  loại khỏi gate — argon2id có chủ đích). Đo trên host dev, chưa phải
  phần cứng pilot — open item 3 vẫn mở.
- `npm run ops:bundle -- --no-images` — không chạy lại lượt này;
  checksum lần cuối verify tại `489cd79`.

## Bổ sung 2026-10-07 — restore/upgrade rehearsal + RPO/RTO đo thực

Lấp ngoại lệ #4 (phần evidence tự động; gate vẫn mở chờ người duyệt).
Host dev, Node v24.21.0, PostgreSQL 18-alpine qua `compose.test.yaml`.

**Điều kiện tiên quyết**: pg_dump/pg_restore đi qua `docker compose exec`
nên chạy `sg docker -c "npm test -- tests/ops/..."`; container test dựng
từ trước khi có service `restore-db` cần
`sg docker -c "npm run db:test:down && npm run db:test:up"` — các test
clean-host có precheck báo đúng lỗi này ("restore-db not reachable on
54330 — run npm run db:test:up").

**Test mới/sửa** (đo trên host dev):

- `tests/ops/upgrade-rehearsal.test.ts` — rehearsal Phase 3 → 4 trọn vẹn:
  schema migrate tới `0005-ai` (`migrate(db, {upTo})`, tuỳ chọn additive,
  production không đổi), seed SQL (personas, `canvas_version` đã publish,
  envelope BYOK mã hoá), `pg_dump -Fc` + manifest → `checkUpgrade()` OK với
  đúng `0006-coaching,0007-oracle` pending; TỪ CHỐI backup 48h > trần RPO
  24h cả khi tuổi đọc từ `createdAt` manifest lẫn fallback mtime file →
  migrate nốt → Phase-3 data nguyên (version history + decrypt envelope)
  và Phase-4 chạy (coaching session + report; ACL 404 cho user không
  share). **Nhánh rollback** trên `restore-db`: wipe roles → bootstrap →
  `pg_restore` dump Phase-3 → bản restored báo đúng `0006+0007` pending và
  canvas Phase-3 đọc được (backup pre-upgrade restore được trên host sạch)
  → `migrate()` + bootstrap trên chính copy đó → lặp lại toàn bộ proof
  app-level (bản restored nâng tiếp lên Phase-4 được). **1/1 PASS.**
- `tests/ops/recovery.test.ts` — **5/5 PASS**, gồm 2 test mới:
  - `clean-host`: restore trọn vẹn lên `restore-db` — service Postgres
    thứ hai trong `compose.test.yaml` (process/volume/port riêng,
    `pg_control_system()` `system_identifier` khác cluster nguồn). Mỗi
    lần chạy wipe `gwp_restore_test` + `DROP OWNED/DROP ROLE` các
    `gwp_*` và assert `pg_roles` không còn role app trước khi bootstrap —
    bootstrap-on-empty được chứng minh, không phải warm-run trên role cũ;
    bootstrap-db-roles chạy TRƯỚC pg_restore (pg_dump không mang roles)
    và SAU để grants đầy đủ; toàn bộ check drill (roles/login/canvas
    history/report ACL/decrypt/publish) xanh trên cluster sạch.
  - `metrics`: spawn thật `ops:restore-test` lên `restore-db`, parse dòng
    `restore-test metrics: {...}` — assert `rtoMs`/`rpoAgeMs`/`backupBytes`
    số. Các bound ≤4h/≤24h trong test chỉ là sanity check trên fixture —
    KHÔNG phải bằng chứng mục tiêu pilot đạt.

**Số đo thực (dev host, dataset fixture seed — nhỏ; KHÔNG phải pilot hw):**

- `ops:restore-test` CLI lên `restore-db`:
  `restore-test metrics: {"rtoMs":1479,"rpoAgeMs":7867,"backupBytes":83172}`
  — `rtoMs` ở đây **chỉ phần restore+smoke** (dropdb/createdb/pg_restore +
  post-checks), không gồm bootstrap roles lẫn check app-level.
- **RTO clean-host đầy đủ** từ drill vitest trên `restore-db` (bootstrap
  roles + pg_restore + grants + login/history/ACL/decrypt/publish):
  `drill metrics (clean-cluster): {"rtoMs":2484,"rpoAgeMs":47,
  "backupBytes":88311,"endpoint":"127.0.0.1:54330"}` → **≈ 2,5 s**.
- `rpoAgeMs` = tuổi backup lúc restore — **cơ chế đo đã kiểm chứng**;
  RPO vận hành = chu kỳ `ops:backup`, phải đo tại pilot (ngoại lệ 3).
  Mục tiêu RTO ≤ 4h / RPO ≤ 24h vẫn phải đo lại trên host triển khai —
  số trên chỉ chứng minh đường đo hoạt động, không phải mục tiêu đã đạt.
- `ops:upgrade-check` CLI sanity: backup mới → `OK: 7 pending migration(s)`;
  backup 48h → `FAIL: backup is 48.0h old — beyond the 24h RPO ceiling`,
  exit 1.

Cơ chế: `runRecoveryDrill` nhận `restoreTarget` tuỳ chọn (clean cluster);
evidence trả `rtoMs`/`rpoAgeMs`/`restoreEndpoint`; `resetCleanCluster()`
wipe `gwp_restore_test` + role `gwp_*` trước mỗi clean drill (guard
DISPOSABLE_HOSTS + port 54330). `ops:restore-test` in dòng metrics máy
đọc được làm dòng cuối. `checkUpgrade()` export từ
`scripts/ops/upgrade-check.ts` — CLI giữ nguyên output/exit code — và đọc
tuổi backup từ `createdAt` manifest (fallback mtime), cùng logic
`backupCreatedAtMs` của restore-test.
