# Runbook — Nâng cấp và rollback (task 4.6, spec §9)

Nguyên tắc: backup đã kiểm tra → maintenance window → migrate một lần có
lock → deploy app → smoke. Rollback app chỉ khi schema tương thích; nếu
migration phá tương thích thì **restore backup** và công bố khoảng mất
dữ liệu — không downgrade mù.

## 1. Trước nâng cấp (ngoài window)

```sh
# Backup mới + kiểm chứng ngay
npm run ops:backup -- --output /srv/gwp-backups/pre-upgrade.dump
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

```sh
npm test -- tests/ops/recovery.test.ts
```

Suite chứng minh: restore trên DB sạch (roles/login/history/ACL/decrypt/
publish), từ chối migrate trên schema mới hơn code, và runtime không phụ
thuộc mạng ngoài (offline).
