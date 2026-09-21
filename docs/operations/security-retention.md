# Runbook — Retention, xoay APP_KEY và ops security (task 4.5, spec §9)

Phạm vi: dọn dữ liệu hết hạn theo lịch, cấu hình retention của owner,
rotation khóa phong bì `APP_KEY`, và giới hạn log vận hành.

## 1. Mô hình credential

| Credential | Dùng cho | Quyền |
|---|---|---|
| `gwp_runtime` (DATABASE_URL) | app sống lâu | DML nghiệp vụ; `audit_event` append-only; không DELETE retention |
| `gwp_maintenance` (MAINTENANCE_DATABASE_URL) | backup, retention, rotate-key | SELECT mọi bảng + DELETE **chỉ** trên `audit_event`, `ai_run`, `write_receipt`, `refresh_token`, `one_time_token` + `UPDATE (value, updated_at)` trên `setting` |
| `gwp_migrator` (MIGRATOR_DATABASE_URL) | migrate/seed | DDL + full DML |

Service `app` không bao giờ thấy URL maintenance — một RCE ở app không
dọn được retention và không đọc/ghi được envelope. Job retention chạy
trong container one-shot riêng, không phải API route.

## 2. Chạy retention hằng ngày

```sh
docker compose run --rm retention
# hoặc trên host đã build image:
docker run --rm --network gwp_default \
  -e MAINTENANCE_DATABASE_URL=postgres://gwp_maintenance:…@db:5432/gwp \
  gwp-app:local node dist/server/src/jobs/retention.js
```

Cron/systemd mẫu (chạy 03:15 hằng ngày):

```cron
15 3 * * * cd /opt/gwp && docker compose run --rm retention >> /var/log/gwp-retention.log 2>&1
```

Output chỉ in số lượng xóa từng nhóm — không in nội dung dòng nào. Job
dùng `pg_advisory_xact_lock` + batch 1000 dòng: hai lần chạy chồng nhau
sẽ xếp hàng thay vì đôi công việc; chạy lại khi không còn gì là no-op.

## 3. Chính sách xóa (mặc định spec §9 — owner chỉ được TĂNG)

| Bảng | Mặc định | Ghi chú |
|---|---|---|
| `audit_event` | 365 ngày | theo `created_at`, per-company |
| `ai_run` | 90 ngày | chỉ trạng thái terminal (succeeded/failed/cancelled/interrupted); `coaching_report.ai_run_id` SET NULL, provenance trên report giữ nguyên |
| `write_receipt` | 7 ngày | khớp cửa sổ receipt trong `shared/write-receipt.ts` |
| `refresh_token` | session chết + 7 ngày | chỉ xóa khi `LEAST(revoked_at, expires_at)` quá horizon — token consumed của session còn sống PHẢI ở lại để reuse-detection hoạt động |
| `one_time_token` | hết hạn + 7 ngày | token chưa dùng nhưng hết hạn cũng dọn |
| `report_share` | **không** xóa theo thời gian | share chỉ hết hiệu lực bằng revoke tường minh hoặc report bị xóa |
| `auth_session` | giữ lại | lịch sử phiên — chỉ token con bị dọn |

Log vận hành (stdout container) được chặn bởi `logging:` driver `local`
với `max-size: 10m, max-file: 3` trên `db` và `app` — log container chết
cùng container, không vượt 30 ngày trong thực tế.

Owner chỉnh floor qua `PATCH /api/v1/settings/retention` — owner-only,
mọi giá trị có min() theo spec; giảm dưới sàn là 400. Job áp
`max(mặc định, cấu hình)` per company cho bảng có company_id, và max toàn
cục cho `write_receipt`.

## 4. Xoay APP_KEY (rotate-key)

`APP_KEY` là ring có phiên bản: `v1=<material>,v2=<material>` — version
cao nhất mã hóa, mọi version còn giữ đều giải mã được. Envelope lưu
`keyVersion`; AAD gồm `companyId:keyVersion` nên envelope không di chuyển
được giữa company hay version.

Quy trình:

```sh
# 1. Sinh material mới vào file bảo vệ (KHÔNG qua argv/stdout)
openssl rand -hex 32 > /run/secrets/app_key_v2   # hoặc secret store nội bộ
chmod 400 /run/secrets/app_key_v2

# 2. Chạy rotation — rewrite mọi envelope trong MỘT transaction
docker compose run --rm \
  -e APP_KEY='v1=<material cũ>' \
  -e MAINTENANCE_DATABASE_URL \
  gwp-app:local node dist/scripts/ops/rotate-key.js \
    --to v2 --material-file /run/secrets/app_key_v2
# (hoặc mount file secret vào container và trỏ --material-file vào đó)

# 3. Cập nhật APP_KEY trong .env — GIỮ cả hai version
APP_KEY='v2=<material mới>,v1=<material cũ>'
docker compose up -d app

# 4. Kiểm chứng: Settings → AI vẫn "Đã cấu hình", test connection xanh.

# 5. Sau khi cửa sổ backup cũ hết hạn (xem §6), bỏ v1 khỏi APP_KEY.
```

Bảo đảm của script:

- Mọi envelope được **giải mã thử trước** — một dòng hỏng/ngoài-ring làm
  abort cả transaction, không có switch dở dang.
- Sau rewrite, từng envelope được mở lại bằng ring mới trong cùng tx
  trước khi commit.
- Không in material/ciphertext — chỉ in số envelope đã rotate.
- `--to` phải cao hơn version đang active; trùng hoặc thấp hơn bị từ chối.

Backup trước rotation vẫn mở được nhờ `v1` còn trong ring — đó là lý do
giữ version cũ tới khi backup window (30 bản ngày) trôi qua.

## 5. Kiểm chứng định kỳ

```sh
# runtime không delete được audit; maintenance không delete được report
npm test -- tests/integration/retention.test.ts
```

Test bao phủ: purge đúng hạn từng bảng, `ai_run_id` SET NULL + provenance
nguyên, share không hết hạn theo thời gian, token cleanup sau horizon,
rotation transaction abort khi envelope hỏng, và envelope decrypt được
bằng ring mới sau rotate.

## 6. Lưu ý backup/restore

- Backup `pg_dump` chứa ciphertext envelope — phục hồi bản cũ cần đúng
  `APP_KEY` version đã seal nó; mất mọi version đó = mất BYOK key (owner
  phải nhập lại — an toàn theo thiết kế).
- Dữ liệu đã bị retention xóa có thể còn trong backup tới hết cửa sổ
  giữ bản — nêu rõ khi trả lời yêu cầu xóa dữ liệu của khách.
