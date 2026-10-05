# deploy/certs

Đặt chứng chỉ của khách ở đây khi không dùng CA nội bộ của Caddy:

- `fullchain.pem` — chứng chỉ + chain
- `privkey.pem` — khóa riêng (chmod 600, **không commit**)

Rồi trong `.env`: `GWP_TLS=/certs/fullchain.pem /certs/privkey.pem`.
Thư mục được mount read-only vào service `proxy` (profile `tls`).
