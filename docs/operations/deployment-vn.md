# Runbook — Triển khai offline/air-gap (task 4.6, spec §9)

Cài đặt GWP trên máy khách **không có Internet**: mọi thứ cần chạy nằm
trong bundle — image tar, compose file, mẫu cấu hình, runbook. Không có
CDN, không telemetry, không pull image lúc chạy.

## 1. Tạo bundle (máy có Internet / máy build)

```sh
docker compose build app            # hoặc build sẵn trong CI
docker pull postgres:18-alpine
npm run ops:bundle -- --output /tmp/gwp-bundle
```

Kết quả:

```
gwp-bundle/
  images/gwp-app_local.tar          app image (đã build)
  images/postgres_18-alpine.tar     DB image
  compose.yaml                      file deploy duy nhất
  .env.example                      mẫu cấu hình — copy thành .env
  Dockerfile                        tham khảo/rebuild khi có source
  docs/operations/*.md              runbook tiếng Việt
  release-manifest.json             danh mục nội dung release
  SHA256SUMS                        checksum mọi artifact
  MANIFEST.json                   biên nhận build (giờ, danh sách file)
```

Bundle **không chứa**: `.env`, dump, `APP_KEY`/`JWT_SECRET` thật, dữ liệu
khách, hay weights của model — model local do khách tự cung cấp (§4).

## 2. Cài trên máy sạch (offline)

```sh
# Kiểm toàn vẹn trước khi load
cd gwp-bundle && sha256sum -c SHA256SUMS

# Nạp image — không cần mạng
docker load -i images/gwp-app_local.tar
docker load -i images/postgres_18-alpine.tar

# Cấu hình
cp .env.example .env
# Sinh secrets thật — mỗi giá trị ≥32 ký tự:
openssl rand -hex 32   # lặp cho JWT_SECRET, APP_KEY, BOOTSTRAP_TOKEN
# Điền: POSTGRES_PASSWORD, GWP_*_PASSWORD, DATABASE_URL,
# MIGRATOR_DATABASE_URL, MAINTENANCE_DATABASE_URL, APP_ORIGIN
# (APP_ORIGIN = https://app.gwp.local — domain nội bộ của khách)

docker compose up -d        # dùng image đã load — không build, không pull
docker compose ps           # app phải "healthy"
curl http://localhost:8080/health/ready   # app phục vụ HTTP; TLS ở proxy (§4)
```

`docker compose up` chỉ build khi image **không** tồn tại — với image đã
`docker load`, compose chạy thẳng image, không động vào `build:` block.

## 3. Bootstrap owner (lần đầu)

```sh
curl -X POST http://localhost:8080/api/v1/setup \
  -H 'Content-Type: application/json' \
  -d '{
    "companyName": "Công ty A",
    "email": "owner@congty.vn",
    "password": "<mật khẩu mạnh ≥ 12 ký tự>",
    "bootstrapToken": "<giá trị BOOTSTRAP_TOKEN trong .env>"
  }'
# → 201 {userId, companyId}; setup đóng vĩnh viễn sau lần này (409 SETUP_CLOSED)
```

Sau bootstrap xong, mở `APP_ORIGIN` trong trình duyệt nội bộ → đăng nhập.

## 4. HTTPS

Compose mặc định phục vụ HTTP nội bộ — TLS kết thúc ở reverse proxy của
khách (nginx/Caddy/Apache đều được). Mẫu nginx tối thiểu:

```nginx
server {
  listen 443 ssl;
  server_name app.gwp.local;
  ssl_certificate     /etc/nginx/certs/app.gwp.local.crt;
  ssl_certificate_key /etc/nginx/certs/app.gwp.local.key;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

`APP_ORIGIN` phải là URL https công khai nội bộ; `TRUST_PROXY=1` (một hop
proxy) hoặc CIDR mạng bridge Docker. **Không** dùng `loopback`: qua port
publish của Docker, container thấy IP gateway bridge (172.x.0.1) chứ không
phải 127.0.0.1 — mọi người dùng sẽ chung một bucket rate-limit và bị 429.

Khi có proxy, publish app chỉ trên loopback để client không vòng qua TLS:
`APP_PORT=127.0.0.1:8080` trong `.env`.

**HTTPS là bắt buộc** cho mọi truy cập ngoài `localhost`: qua
`http://<IP-LAN>:8080` trình duyệt chặn CSS/JS (CSP
`upgrade-insecure-requests`), không có `navigator.locks` (trang login báo
trình duyệt không hỗ trợ) và bỏ cookie `Secure` — không đăng nhập được.

## 5. Local LLM (BYOK)

- Model chạy trên host LAN của khách (Ollama/vLLM/OpenAI-compatible) —
  bundle không mang weights.
- `AI_ALLOWED_HOSTS` trong `.env` liệt kê đúng `host:port` của LLM —
  đây là egress allowlist duy nhất; mọi đích khác bị từ chối.
- Owner/admin nhập API key tại Settings → AI; key mã hóa bằng `APP_KEY`
  (AES-256-GCM, envelope có keyVersion). Mất mọi version trong ring ⇒
  phải nhập lại key — đó là thiết kế.

## 6. Log và đĩa

- Log container bị chặn bởi `logging:` driver `local` (10m × 3 file) —
  `docker compose logs` hoạt động bình thường, đĩa không phình vô hạn.
- Đầy đĩa: kiểm tra `docker system df`; volume `db-data` là mốc chính —
  không xóa tay; mở rộng đĩa hoặc chạy retention trước:
  `docker compose run --rm retention`.
- Backup hằng ngày và restore drill: xem `docs/operations/recovery.md`.
- Nâng cấp/rollback: xem `docs/operations/upgrade.md`.
- Xoay APP_KEY + retention: `docs/operations/security-retention.md`.
