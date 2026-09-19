# Phase 0 — Bằng chứng nghiệm thu

Ngày: 2026-09-20. Branch: `feat/real-app-design`.
Chi tiết đầy đủ (command + output verbatim):
`.superpowers/sdd/2026-09-20-phase-0-foundation/task-0.6-report.md`.

## Điều kiện nghiệm thu spec §10 (Phase 0)

| Điều kiện | Bằng chứng |
|---|---|
| Setup đua chỉ tạo một owner | `setup.test.ts`: "parallel setup requests produce exactly one 201 and one 409" — xanh |
| Login/refresh/reuse/logout/deactivate đúng | `auth.test.ts` 13 tests xanh (rotation, reuse-revocation, durable revoke) |
| Restart giữ DB | Smoke compose: `docker compose restart app` → login lại owner cùng userId `638c112c-…` → 200 |
| Static không lộ source/secrets | `static-boundary.test.ts` 22 tests xanh; live container: `/.env` 404, `/server/src/config.ts` 404 |
| Không còn production login giả | Auth chạy Argon2id + DB thật; persona fixtures chỉ trong test |
| Backup/restore smoke | `ops:backup` → `/tmp/gwp-foundation.dump` 24833 bytes; `ops:restore-test` → `gwp_restore_test`, `counts(company\|schema_migration)=1\|1` |
| `docker compose config --quiet` | exit 0 (có trong deployment.test.ts) |
| `docker compose up -d --build` | stack healthy: db (healthy) → db-bootstrap exit 0 → migrate exit 0 → app healthy |
| Health phân tầng | live 200 không chạm DB; ready 503 `DB_UNAVAILABLE`/`MIGRATIONS_PENDING` khi DB down/chưa migrate |
| OpenAPI public | `GET /api/v1/openapi.json` → OpenAPI 3.0.3, 7 path Phase 0, test assert không chứa secret |
| DB không publish port | compose render: `services.db.ports` rỗng (test assert); app publish `0.0.0.0:${APP_PORT}:8080` — LAN theo yêu cầu |
| Graceful SIGTERM | log container: `SIGTERM received — draining connections` rồi listen lại sau restart |
| Migrator một lần + lock | `migrate` service exit 0: `applied: 0001-foundation; pending: 0`; test re-run idempotent |

## Test suite

- `npm test`: 72/72 xanh (6 file integration trên PostgreSQL thật,
  compose.test.yaml @127.0.0.1:54329). LƯU Ý: đã thấy flake ngẫu nhiên
  (timeout 30s/socket hang up ở các test argon2-nặng khi chạy song song) —
  mỗi lần fail là một test khác nhau và đều pass khi chạy lại; cần theo dõi.
- `npm run typecheck`: exit 0. `npm run build`: dist + public-build 16 file.
- `npm run test:e2e`: Playwright login flow thật trên `gwp_e2e`.

## Image digest (build 2026-09-20)

- `gwp-app:local` `sha256:1bd6c8264928d1e2617da978415f9cffb2deb5de28b78048239e832278f25bff`
- `node:24-bookworm-slim` `node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`
- `postgres:18-alpine` `postgres@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd`

## Giới hạn đã biết (không chặn Phase 0)

- Cookie refresh `Secure`: trên `http://` LAN (không localhost) browser không
  lưu cookie → refresh/logout cần reverse proxy HTTPS — đã ghi runbook §6.
- Restore drill là smoke kỹ thuật (schema + count), chưa phải full drill
  spec §9 (login/quyền/version history) — chờ canvas ở Phase 2+.
- `demo`/`production` tách volume/secrets bằng `.env` riêng; bundle một
  `.env` cho local path — production nên qua secret store (spec §9).
