# Runbook — Nâng cấp và rollback (task 4.6, spec §9)

Nguyên tắc: backup đã kiểm tra → maintenance window → migrate một lần có
lock → deploy app → smoke. Rollback app chỉ khi schema tương thích; nếu
migration phá tương thích thì **restore backup** và công bố khoảng mất
dữ liệu — không downgrade mù.

## 1. Trước nâng cấp (ngoài window)

```sh
# Backup mới + kiểm chứng ngay
# (lệnh docker compose run … backup.js như recovery.md §1, --output
#  /backups/pre-upgrade.dump; hoặc npm run ops:backup trên máy có source)
docker compose run --rm --no-deps -v /srv/gwp-backups:/backups \
  -e BACKUP_DATABASE_URL="$(grep ^BACKUP_DATABASE_URL= .env | cut -d= -f2-)" \
  app node dist/scripts/ops/backup.js --output /backups/pre-upgrade.dump
npm run ops:restore-test -- --backup /srv/gwp-backups/pre-upgrade.dump
#   → phải in "recreated and verified" và KHÔNG có cảnh báo migration lạ
```

## 2. Preflight trong maintenance window

```sh
npm run ops:upgrade-check -- \
  --url "$MAINTENANCE_DATABASE_URL" \
  --backup /srv/gwp-backups/pre-upgrade.dump
```

`upgrade-check` fail (exit 1) khi:

- backup thiếu/rỗng hoặc cũ hơn 24h (RPO ceiling — `--max-backup-age-hours`);
- backup được tạo từ schema **mới hơn** code (manifest có migration lạ);
- DB hiện tại có migration mà build này không biết → **không deploy**:
  app mới hơn DB thì migrate; DB mới hơn app thì nâng app, không rollback.

Output OK in danh sách migration sẽ chạy — đối chiếu release notes.

## 3. Nâng cấp

```sh
docker load -i images/gwp-app_local_<mới>.tar   # bundle của bản mới
docker compose up -d --no-deps db db-bootstrap
docker compose run --rm migrate                # chạy ĐÚNG 1 lần — có
                                               # advisory lock nội bộ
docker compose up -d app
curl -k https://localhost:8080/health/ready    # 200 ok mới cho user vào
```

- Migrator tự khóa `pg_advisory_xact_lock` per-migration — hai lần chạy
  chồng nhau serialize, lần sau thấy đã applied và bỏ qua.
- `/health/ready` trả 503 `MIGRATIONS_PENDING` khi thiếu migration,
  503 `SCHEMA_AHEAD_OF_CODE` khi DB mới hơn code — orchestrator nhìn
  readiness, app không phục vụ request trong cả hai trường hợp.

## 4. Smoke sau nâng cấp

```sh
curl -k -X POST https://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' -H "Origin: $APP_ORIGIN" \
  -d '{"email":"owner@congty.vn","password":"…"}'
# Mở dashboard → 1 canvas đã publish → Settings → AI test connection
```

## 5. Rollback

| Tình huống | Làm gì |
|---|---|
| Migration chưa chạy / chỉ app đổi | Load lại image cũ, `docker compose up -d app` — schema vẫn tương thích |
| Migration ĐÃ chạy và phá tương thích | Không rollback mù: restore `pre-upgrade.dump` theo recovery.md §4, công bố khoảng dữ liệu mất = giờ backup → giờ sự cố |
| App cũ chạy trên schema mới | Bị readiness chặn (`SCHEMA_AHEAD_OF_CODE`) — đó là bảo vệ có chủ đích |

`migrate` từ chối chạy trên DB chứa migration lạ — thông điệp lỗi nêu
đúng tên migration để đối chiếu release.

## 6. Diễn tập trước khi bàn giao

Điều kiện tiên quyết — pg_dump/pg_restore đi qua `docker compose exec` nên
lệnh chạy trong **group docker**, và container test cũ (tạo trước khi có
service `restore-db`) phải được dựng lại:

```sh
# Nếu restore-db chưa tồn tại (container up từ compose cũ):
sg docker -c "npm run db:test:down && npm run db:test:up"
#   → compose.test.yaml: test-db (54329) + restore-db (54330, cluster sạch)

sg docker -c "npm test -- tests/ops/recovery.test.ts tests/ops/upgrade-rehearsal.test.ts"
# Lỗi "restore-db not reachable on 54330 — run npm run db:test:up" nghĩa
# là cluster sạch chưa dựng — chạy lại cặp down/up ở trên.
```

Suite `recovery.test.ts` chứng minh: restore trên DB sạch (roles/login/
history/ACL/decrypt/publish), restore lên **cluster riêng** `restore-db`
(system_identifier khác — bằng chứng clean-host; drill luôn wipe
`gwp_restore_test` + các role `gwp_*` và assert cluster rỗng trước khi
bootstrap, nên mỗi lần chạy kiểm chứng bootstrap-on-empty), `ops:restore-test`
in dòng `restore-test metrics:` với RTO/RPO đo được, từ chối migrate trên
schema mới hơn code, và runtime không phụ thuộc mạng ngoài (offline).

`upgrade-rehearsal.test.ts` diễn tập **nâng cấp Phase 3 → Phase 4** trọn
vẹn trên schema disposable, gồm cả nhánh rollback:

1. Schema `test_*` migrate chỉ tới `0005-ai` (`migrate(db, {upTo})` — tuỳ
   chọn chỉ dành cho test/rehearsal; migrator production luôn chạy hết) —
   tái hiện đúng schema Phase 3.
2. Seed dữ liệu Phase 3 bằng SQL: users owner/member, canvas đã publish
   (`canvas_version`), envelope AI BYOK mã hoá bằng APP_KEY.
3. `pg_dump -Fc` + manifest sidecar → `checkUpgrade()` (cùng logic
   `ops:upgrade-check`) phải OK với đúng 2 migration pending
   (`0006-coaching`, `0007-oracle`). Tuổi backup đọc từ `createdAt` của
   manifest (fallback mtime file khi không có manifest) — và gate phải
   TỪ CHỐI cả hai cách khi backup cũ hơn trần RPO 24h.
4. `migrate()` chạy nốt 0006/0007 → `bootstrap-db-roles` cấp lại grants —
   đúng trình tự runbook §3.
5. Kiểm chứng trên app thật: dữ liệu Phase 3 nguyên vẹn (version history
   đọc được, envelope giải mã được), Phase 4 hoạt động (tạo coaching
   session + report; ACL chặn user không được share — 404).
6. **Nhánh rollback trên cluster sạch**: dump Phase 3 ở bước 3 được
   `pg_restore` lên `restore-db` (sau khi wipe roles + bootstrap trên
   cluster đó) — bản restored phải báo đúng cặp pending
   `0006-coaching`/`0007-oracle` và canvas Phase 3 đọc được (chứng minh
   backup pre-upgrade restore được); rồi `migrate()` + bootstrap trên
   chính bản đó và lặp lại toàn bộ kiểm chứng bước 5 — tức backup
   pre-upgrade vừa restore được trên host sạch, vừa nâng tiếp lên Phase 4
   được.

Đoạn tương đương manual trên staging: dump DB Phase 3 → `ops:upgrade-check`
→ migrate → smoke §4; rollback: restore dump theo recovery.md §3a → smoke
(đường quay lại) hoặc `ops:upgrade-check` + migrate (đường đi tiếp).
