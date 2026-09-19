# Runbook Phase 0 — Nền tảng GWP (vận hành cơ bản)

Phạm vi: gói Compose self-hosted (app + PostgreSQL), biến môi trường,
bootstrap owner, demo vs production, TLS/reverse proxy, backup/restore
smoke, và nâng cấp. Tham chiếu spec §2/§8/§9.

## 1. Thành phần gói triển khai

```
compose.yaml          production-shaped + đường chạy local
Dockerfile            multi-stage node:24-bookworm-slim, non-root
.dockerignore         context sạch — .env/tests/docs không vào image
server/openapi.yaml   hợp đồng API public, phục vụ tại /api/v1/openapi.json
scripts/ops/          bootstrap-db-roles, backup, restore-test
.env                  secrets local (gitignored — tự tạo từ .env.example)
```

Bốn service trong `compose.yaml`:

| Service | Vai trò |
|---|---|
| `db` | postgres:18-alpine, volume `db-data` bền, **không publish port** — chỉ mạng nội bộ compose |
| `db-bootstrap` | one-shot: tạo role `gwp_migrator`/`gwp_runtime`/`gwp_maintenance` + grant tối thiểu, đặt password từ `GWP_*_PASSWORD` trong `.env` |
| `migrate` | one-shot: chạy `npm run db:migrate` (dạng đã biên dịch `node dist/server/src/db/migrate.js`) với `MIGRATOR_DATABASE_URL`, xong thì exit |
| `app` | image `gwp-app:local` build từ Dockerfile; publish `${APP_PORT:-8080}:8080` **trên mọi interface** — truy cập LAN là yêu cầu |

Thứ tự boot: `db` healthy → `db-bootstrap` exit 0 → `migrate` exit 0 →
`app`. App tự phục vụ degraded khi DB chưa migrate: `/health/live` vẫn 200,
`/health/ready` trả 503 (`MIGRATIONS_PENDING`/`DB_UNAVAILABLE`) cho tới khi
migrator chạy xong — không cần restart.

## 2. Cài đặt

Yêu cầu: Docker + Docker Compose v2. Node 24+ chỉ cần cho phát triển host.

```sh
cp .env.example .env
# Sinh secrets thật (mỗi giá trị ≥ 32 ký tự):
openssl rand -hex 32   # lặp cho JWT_SECRET, APP_KEY, BOOTSTRAP_TOKEN
# và đặt POSTGRES_PASSWORD + GWP_*_PASSWORD + các URL tương ứng

docker compose config --quiet    # validate trước
docker compose up -d --build
docker compose ps                # app phải "healthy"
curl http://localhost:8080/health/ready
```

Không cần `.env` để `docker compose config` pass (biến thiếu chỉ render
chuỗi rỗng kèm cảnh báo), nhưng stack chỉ boot được khi `.env` có đủ
secrets — mỗi consumer fail-fast rõ ràng: `loadConfig` báo "missing
required env", postgres entrypoint đòi `POSTGRES_PASSWORD`, migrator đòi
`MIGRATOR_DATABASE_URL` khi `NODE_ENV=production`.

Mô hình least-privilege: `compose.yaml` **không** dùng `env_file` — mỗi
service chỉ nhận đúng allowlist `environment:` của nó. `app` (process
sống lâu, mặt tấn công chính) không bao giờ mang `POSTGRES_*`,
`MIGRATOR_DATABASE_URL`, `BACKUP_DATABASE_URL`, `BOOTSTRAP_ADMIN_URL` hay
`GWP_*_PASSWORD` — một RCE ở app không thành chiếm DB trọn vẹn. Chỉ
one-shot `db-bootstrap` giữ superuser URL; chỉ `migrate` giữ credential
DDL; `db` chỉ giữ `POSTGRES_DB/USER/PASSWORD`. Deployment test assert
chính xác các key-set này.

## 3. Bảng biến môi trường

| Biến | Bắt buộc | Vai trò |
|---|---|---|
| `DATABASE_URL` | ✔ | postgres:// runtime role `gwp_runtime` (DML, không DDL) |
| `MIGRATOR_DATABASE_URL` | ✔ khi `NODE_ENV=production` | credential `gwp_migrator` có DDL — chỉ migrate/ops dùng |
| `BOOTSTRAP_ADMIN_URL` | chỉ service `db-bootstrap` | superuser URL để tạo role |
| `BACKUP_DATABASE_URL` | ops | role `gwp_maintenance` (SELECT) cho `ops:backup` |
| `JWT_SECRET` | ✔ | ký access JWT HS256 (≥32 ký tự khi production) |
| `APP_KEY` | ✔ | master key mã hoá (BYOK phase 3) — ≥32 ký tự |
| `BOOTSTRAP_TOKEN` | ✔ | token một lần mở cửa POST /api/v1/setup |
| `DEMO_MODE` | ✔ | `production`/`demo` — **bất biến theo DB**, migrate ghi vào `deployment_state`; đổi sau = boot từ chối |
| `APP_ORIGIN` | ✔ | origin public chính xác — refresh/logout kiểm `Origin` khớp |
| `PORT` | mặc định 8080 | port lắng nghe trong container |
| `APP_PORT` | mặc định 8080 | port host publish ra LAN |
| `TRUST_PROXY` | mặc định `false` | số hop proxy (vd `1`) hoặc CIDR khi sau reverse proxy |
| `ACCESS_TOKEN_TTL_SECONDS` | 600 | TTL access JWT |
| `REFRESH_TOKEN_TTL_SECONDS` | 604800 | vòng đời tuyệt đối session refresh |
| `GWP_SET_ROLE_PASSWORDS` | chỉ `db-bootstrap` | opt-in cho phép đặt password role khi `NODE_ENV=production` |

## 4. Bootstrap owner (lần đầu)

Setup chỉ mở đúng một lần — xong đóng vĩnh viễn (409 SETUP_CLOSED):

```sh
curl -X POST http://localhost:8080/api/v1/setup \
  -H 'Content-Type: application/json' \
  -d '{
    "companyName": "Công ty A",
    "email": "owner@congty.local",
    "password": "<mat-khau ≥ 12 ky tu>",
    "bootstrapToken": "<gia tri BOOTSTRAP_TOKEN trong .env>"
  }'
# → 201 {userId, companyId}; KHÔNG cấp token — đăng nhập ngay sau:
curl -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@congty.local","password":"<mat-khau>"}'
# → 200 {accessToken, user} + cookie gwp_refresh (HttpOnly) + gwp_csrf
```

Mất `BOOTSTRAP_TOKEN` → tạo lại trong `.env` rồi `docker compose up -d`
(app đọc env lúc boot; nếu setup đã đóng thì token không còn tác dụng).

## 5. Demo vs production

- `DEMO_MODE` là thuộc tính bất biến của DB, ghi bởi migrator vào
  `deployment_state`. Boot app sẽ **từ chối chạy** nếu env khác mode đã ghi
  — không có cách "lật" mode mà không tạo DB mới.
- `demo` cho phép seed nhân danh minh hoạ (script `seed-demo`); `production`
  không seed gì — chỉ có owner bootstrap tạo.
- Không dùng chung volume/secrets giữa demo và production.

## 6. TLS / reverse proxy

- Gói Phase 0 phục vụ HTTP trên `0.0.0.0:APP_PORT` — phù hợp LAN/QA. Triển
  khai thật BẮT BUỘC HTTPS qua reverse proxy (nginx/Caddy/Traefik hoặc hạ
  tầng khách có sẵn): terminate TLS tại proxy, forward tới `app:8080`.
- Khi sau proxy: đặt `APP_ORIGIN=https://<domain>` đúng origin public, và
  `TRUST_PROXY=1` (hoặc số hop/CIDR) để `req.ip` đúng cho rate-limit.
- Cookie refresh là `Secure` — trên `http://` chỉ localhost được browser
  chấp nhận; truy cập LAN qua http sẽ login được nhưng refresh/logout cần
  HTTPS (hạn chế đã biết của pilot, ghi rõ để QA không nhầm lỗi).

## 7. Backup / restore

Backup: `pg_dump -Fc` qua `npm run ops:backup -- --output <path>`.

- Trong container app đã có `postgresql-client` → chạy local PATH.
- Trên host không có pg tools → script tự fallback `docker compose exec`
  vào service `db` (không cần publish port DB).
- Nguồn: `--url` > `BACKUP_DATABASE_URL` > `DATABASE_URL`. Không bao giờ
  log URL/password; chỉ in path + kích thước file.
- File output là custom format — **không** copy live data directory.

Restore DRILL (không phải production restore):

```sh
npm run ops:restore-test -- --backup /tmp/gwp-foundation.dump \
  --target <maintenance-url>          # host disposable thì khỏi flag
                                     # host khác: thêm --i-understand
```

- Luôn drop+create DB tên cố định `gwp_restore_test` — không flag nào đổi
  được; không bao giờ ghi đè `gwp_test` hay DB thật.
- `--target` phải trỏ host disposable (127.0.0.1/localhost/::1) hoặc cần
  `--i-understand` tường minh; script tự kiểm `current_database()` lần hai
  trước khi chạy DDL phá huỷ.
- Sau `pg_restore --exit-on-error` chạy smoke query
  (`count company` + `schema_migration`) — in ra để đối chiếu.
- Retention mục tiêu spec §9: giữ 30 bản ngày, kho tách failure domain,
  mã hoá riêng; backup có thể còn dữ liệu đã xoá tới hết retention — phải
  nêu khi bàn giao. `APP_KEY` sao lưu riêng — thiếu nó ciphertext BYOK
  không khôi phục được (phase 3).

## 8. Nâng cấp (upgrade note)

1. Backup đã kiểm tra (`ops:backup` + `ops:restore-test` xanh).
2. Maintenance window; `docker compose up -d --build` (migrate one-shot có
   advisory lock — chạy đúng một lần kể cả đua).
3. Smoke: `/health/ready` 200, login thử, app log sạch.
4. Rollback app chỉ khi schema tương thích; nếu migration phá tương thích →
   restore backup và công bố khoảng dữ liệu mất — không downgrade mù.

## 9. Health probes & graceful shutdown

- `GET /health/live` — 200 khi process sống, không chạm DB (HEALTHCHECK
  trong image dùng endpoint này).
- `GET /health/ready` — 200 chỉ khi DB reachable + đủ migrations; 503 với
  envelope `{code: DB_UNAVAILABLE|MIGRATIONS_PENDING, ...}`.
- SIGTERM: dừng nhận request mới, drain tối đa 10s, `db.destroy()` rồi exit.
  `docker compose restart app` cho thấy log `SIGTERM received — draining`.

## 10. Bằng chứng smoke đã chạy (2026-09-20)

```text
$ docker compose config --quiet                       → exit 0
$ docker compose up -d --build                        → db healthy →
  db-bootstrap exit 0 → migrate "db:migrate complete —
  applied: 0001-foundation; pending: 0" → app healthy
$ curl :8085/health/live|ready                        → 200 / 200
$ curl :8085/api/v1/openapi.json                      → openapi 3.0.3,
  7 paths, không secret
$ POST /api/v1/setup                                  → 201 owner
$ POST /api/v1/auth/login + GET /api/v1/auth/me       → 200, roles=[owner]
$ npm run ops:backup -- --output /tmp/gwp-foundation.dump
  → "backup written: /tmp/gwp-foundation.dump (24833 bytes,
     pg_dump -Fc, via docker compose exec db)"
$ npm run ops:restore-test -- --backup /tmp/gwp-foundation.dump \
    --target <admin-url>                              → từ chối (host "db"
    không disposable) cho tới khi thêm --i-understand →
  "counts(company|schema_migration)=1|1; restore-test complete"
$ docker compose restart app                          → log SIGTERM drain;
  login lại owner cùng id sau restart → 200 (persistence qua named volume)
$ POST /api/v1/setup lần 2                            → 409 SETUP_CLOSED
$ GET /.env, /server/src/config.ts                    → 404 (static boundary)
```

Port smoke dùng `APP_PORT=8085` vì 8080/8081 trên máy dev đã bị chiếm —
đổi tự do bằng `.env`. Stack đang chạy tại `http://localhost:8085` và
`http://<LAN-IP>:8085` (publish mọi interface).

## 11. Image digests (build smoke 2026-09-20)

| Image | Digest |
|---|---|
| `gwp-app:local` (manifest) | `sha256:1bd6c8264928d1e2617da978415f9cffb2deb5de28b78048239e832278f25bff` |
| `node:24-bookworm-slim` | `node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` |
| `postgres:18-alpine` | `postgres@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd` |

Khi release thật: pin digest base image trong Dockerfile
(`node:24-bookworm-slim@sha256:...`) và ghi digest image build ra registry.
