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

- `npm test`: 73/73 xanh (6 file integration trên PostgreSQL thật,
  compose.test.yaml @127.0.0.1:54329). LƯU Ý: hai loại flake đã thấy —
  (1) timeout 30s/socket hang up ở các test argon2-nặng khi chạy song song
  (mỗi lần một test khác nhau, pass khi chạy lại — theo dõi Phase 1);
  (2) race `pg_dump` toàn-DB trên `gwp_test` với fixture schema bị drop
  song song — ĐÃ SỬA trong commit `c61b336` bằng DB nguồn riêng
  `gwp_backup_src` mà chỉ test đó chạm vào (phát hiện bởi review Codex).
- `npm run typecheck`: exit 0. `npm run build`: dist + public-build 16 file.
- `npm run test:e2e`: Playwright login flow thật trên `gwp_e2e`.

## Image digest (build 2026-09-20)

- `gwp-app:local` `sha256:cb8e1d66f15a1e4a77ae6abd7c3345d9879a66bdbf121ec6e3b42d0dce099da6` (rebuild sau fix index.html)
- `node:24-bookworm-slim` `node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`
- `postgres:18-alpine` `postgres@sha256:6c538e7206ea40ff740ef27883529390a690b6ead6ba96b44c67a9f7c638e8fd`

## Review độc lập (Codex gpt-5.6-terra:high)

- Gate 1: FAIL — phát hiện race `pg_dump` toàn-DB trên `gwp_test` với
  fixture schema đang bị drop song song (72/73, fail đúng test đó).
  Phần còn lại sạch: boundary `/api/v1`, auth/session, audit append-only,
  static allowlist, env scoping, e2e 5/5, restart giữ owner.
- Fix `c61b336` + `78a187a` + `d19e909` → re-check: fix review PASS,
  `npm test` 73/73 không còn race, typecheck + e2e 5/5 PASS, seed-demo
  từ chối production đúng. Chặn duy nhất còn lại: container đang chạy
  image cũ (trước fix index.html) → đã `docker compose up -d --build app`
  và verify live: `/index.html` không còn `fixture-password`/`example.test`,
  health live+ready 200.

## Giới hạn đã biết (không chặn Phase 0)

- Cookie refresh `Secure`: trên `http://` LAN (không localhost) browser không
  lưu cookie → refresh/logout cần reverse proxy HTTPS — đã ghi runbook §6.
- Restore drill là smoke kỹ thuật (schema + count), chưa phải full drill
  spec §9 (login/quyền/version history) — chờ canvas ở Phase 2+.
- `demo`/`production` tách volume/secrets bằng `.env` riêng; bundle một
  `.env` cho local path — production nên qua secret store (spec §9).
