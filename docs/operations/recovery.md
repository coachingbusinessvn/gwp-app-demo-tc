# Runbook — Backup và phục hồi (task 4.6, spec §9)

Mục tiêu pilot: **RPO ≤ 24 giờ, RTO ≤ 4 giờ** — đo bằng restore drill
thật, không phải SLA cam kết.

## 1. Backup hằng ngày

```sh
# Cron 02:30 — ghi ra kho riêng failure domain với volume db-data
# Chạy trong image app (có pg_dump 18 + script đã biên dịch) — host không
# cần Node/npm. BACKUP_DATABASE_URL lấy từ .env (role gwp_maintenance).
30 2 * * * cd /opt/gwp && \
  docker compose run --rm --no-deps -v /srv/gwp-backups:/backups \
    -e BACKUP_DATABASE_URL="$(grep ^BACKUP_DATABASE_URL= .env | cut -d= -f2-)" \
    app node dist/scripts/ops/backup.js --output /backups/gwp-$(date +\%F).dump && \
  ls -t /srv/gwp-backups/gwp-*.dump | tail -n +31 | xargs -r rm -f
```

> Trên máy có source checkout + `npm ci` (dev/QA) có thể dùng
> `npm run ops:backup -- --output …` với `BACKUP_DATABASE_URL` trỏ
> `127.0.0.1` — script đọc `BACKUP_DATABASE_URL`, rồi `DATABASE_URL`.

- Giữ **30 bản ngày**; thư mục backup trên máy/partition khác DB hoặc
  rsync sang host khác — cùng failure domain với `db-data` không tính.
- Mỗi `.dump` kèm `.dump.manifest.json` (giờ tạo + danh sách
  schema_migration) — `upgrade-check` và `restore-test` đọc nó để phát
  hiện backup của release mới hơn code đang chạy.
- `pg_dump -Fc` qua credential `gwp_maintenance` (read-only). **Không**
  copy `pg_data` sống — dump mới là bản nhất quán.

## 2. Backup secrets — riêng, mã hóa

DB dump **không** chứa và không thay thế được:

| Thứ phải backup riêng | Vì sao |
|---|---|
| `APP_KEY` ring đầy đủ (mọi `vN=`) | Envelope BYOK chỉ mở được bằng đúng version đã seal; mất version ⇒ mất AI key (an toàn theo thiết kế — nhập lại key là đường duy nhất) |
| `JWT_SECRET` | Session đang sống bị vô hiệu nếu đổi — không mất dữ liệu, nhưng người dùng phải login lại |
| Role passwords / POSTGRES_PASSWORD | pg_dump không mang cluster roles; restore trên cluster sạch cần `bootstrap-db-roles` |
| `.env` (mẫu đã điền) | Cấu hình phục hồi — lưu như secret, không vào repo |

Secrets backup vào secret store nội bộ hoặc file `chmod 400` mã hóa —
tách khỏi thư mục dump.

## 3. Restore drill (chạy định kỳ, ít nhất mỗi lần trước khi bàn giao)

Trên máy hoặc DB **sạch**:

```sh
# 1. Cluster roles (pg_dump không mang roles)
docker compose run --rm db-bootstrap       # hoặc chạy bootstrap-db-roles

# 2. Restore vào DB drill — script chỉ đụng gwp_restore_test, không bao
#    giờ đụng DB thật; target non-local cần --i-understand
npm run ops:restore-test -- --backup /srv/gwp-backups/gwp-2026-09-21.dump

# 3. Đọc cảnh báo cuối output: roles thiếu, migration lạ (backup mới hơn
#    code → không chạy app/migrate trên nó), version APP_KEY cần thiết.

# 4. Ghi lại bằng chứng: giờ bắt đầu/kết thúc (RTO thực đo), tuổi backup
#    (RPO), kết quả smoke query.
```

Drill tự động trong CI: `npm test -- tests/ops/recovery.test.ts` chứng
minh trên DB sạch: roles+grants, login thật, lịch sử canvas version nguyên
vẹn, report ACL + share, giải mã envelope BYOK bằng APP_KEY, publish thử
— và DB nguồn không bị đụng.

## 4. Phục hồi thật (sau sự cố)

```sh
# Trên máy mới: cài bundle (deployment-vn.md §2), điền .env gồm APP_KEY
# ring ĐÚNG version đã seal envelope.
docker compose up -d db
docker compose cp /srv/gwp-backups/<latest>.dump db:/tmp/restore.dump
docker compose exec db createdb -U gwp gwp_restored
docker compose exec db pg_restore --exit-on-error -U gwp -d gwp_restored /tmp/restore.dump
# Roles: chạy bootstrap-db-roles với password mới/đã lưu
# Trỏ DATABASE_URL/MIGRATOR_DATABASE_URL sang DB mới → docker compose up -d
# Smoke: login owner, mở 1 canvas đã publish, Settings → AI → test connection
```

Lưu ý RPO công bố: dữ liệu sau mốc backup mất vĩnh viễn — báo cho owner
khoảng mất cụ thể. Dữ liệu đã bị retention xóa vẫn có thể nằm trong backup
cũ tới hết 30 ngày — phải nêu khi khách yêu cầu xóa dữ liệu.
