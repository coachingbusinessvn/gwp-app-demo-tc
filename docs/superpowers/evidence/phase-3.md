# Phase 3 — Bằng chứng nghiệm thu (AI nội bộ BYOK)

Ngày: 2026-09-22. Branch: `feat/real-app-design`.
Plan: `docs/superpowers/plans/2026-09-20-phase-3-local-ai-byok.md`.

Commits theo task: 3.1 `bcc8965`, 3.2 `e847452`, 3.3 `ed9f482`,
3.4 `6f366e2`, 3.5 `b91f104`, 3.6 (UI + e2e + docs — commit trên cùng
file này).

## Kết quả kiểm chứng cuối phase (HEAD sau 3.6)

- `npm test` — **381/381** (29 file): unit adapter/preview/coach-output/
  canvas-model + integration ai-settings/ai-runs/renderer/coach trên
  PostgreSQL thật.
- `npm run typecheck` — 0 lỗi.
- `npm run build` — `public-build/` 36 file (`web/ai` trong allowlist).
- `npx playwright test` — **26/26**, gồm `tests/e2e/ai.spec.ts` 4/4
  trên fake LLM loopback `127.0.0.1:18923` qua đúng code path allowlist
  production (`AI_ALLOW_HTTP` + `AI_ALLOWED_HOSTS` chỉ bật trong env e2e).
- `git diff --check` — sạch.

## Exit gate → bằng chứng

| Gate | Bằng chứng |
|---|---|
| Test adapter/run/Renderer/Coach/UI PASS; AI off không cản canvas | Số liệu trên; e2e "AI not configured" chứng minh editor vẫn load + autosave bình thường |
| Model local thật qua connection test + bộ 12 mẫu reviewer duyệt | **BLOCKED** — chưa có endpoint local được operator duyệt; xem `docs/evaluation/canvas-ai.md` (checklist 12 fixture sẵn sàng, chưa chạy). Không khẳng định chất lượng đạt |
| Timeout/cancel/restart/no-consent/revocation/stale draft không ghi sai | `ai-adapter.test.ts` (timeout 180s fake-clock, abort đóng kết nối, upstream 401/429/5xx); `ai-runs.test.ts` (no-consent 400, 2 active → 429, idempotent replay, changed-hash 409, expiry 410, restart → interrupted, raw notes vắng mặt trong DB); `renderer.test.ts` (revoked 404, stale draft/base 409, forged client body bị bỏ qua) |
| `phase-3.md` provenance redacted + reviewer decisions | File này; không chứa key/endpoint thật |

## Các phát hiện đáng nhớ theo task

### 3.1 (BYOK settings)

- Key mã hoá AES-256-GCM bằng `APP_KEY` (ring `APP_KEY_RING` cho rotation),
  envelope `v<kid>.<iv>.<tag>.<ct>`; GET không bao giờ trả key/ciphertext —
  chỉ `configured: true`.
- Destination allowlist chạy lúc **save** lẫn **dispatch** — admin đổi
  `AI_ALLOWED_HOSTS` là endpoint cũ chết ngay, kể cả khi settings đã lưu.
- HTTP mặc định bị cấm; `AI_ALLOW_HTTP=true` chỉ cho test/loopback.

### 3.2 (adapter)

- SSE parser xử lý frame tách giữa byte UTF-8, `[DONE]`, non-stream JSON;
  `AbortSignal` huỷ đóng socket thật (fake LLM xác nhận phía server).
- Timeout 180s qua AbortController — fake-clock test, không sleep thật.
- Lỗi upstream normalize về `AI_UPSTREAM_*`/`AI_UNAVAILABLE` — không rò
  body provider vào client.

### 3.3 (run lifecycle)

- Consent bắt buộc mỗi run (`AI_CONSENT_REQUIRED`); idempotency-key +
  input-hash → replay trả cùng run, hash đổi → 409.
- Active-run cap 2/company (429); preview store in-process, TTL 15 phút,
  apply consume một lần; restart sweep → `interrupted`.
- `ai_run` chỉ giữ metadata + `input_hash` — notes/model output không
  persist (kiểm chứng bằng truy vấn DB trực tiếp trong test).

### 3.4 (renderer proposal → apply)

- Prompt `server/prompts/renderer/` có manifest SHA-256 — prompt bị sửa
  mà manifest không cập nhật → run fail `PROMPT_INTEGRITY`.
- Proposal parse qua đúng canonical Markdown parser của manual import;
  diff + issues stable-id; warning phải tick đủ mới apply.
- Apply dùng **server-held preview** — body client gửi lên bị bỏ qua
  (test forged-body); CAS trên `expectedRevision` + published-version
  chụp lúc stage; stamp `source:"ai"` + `ai_run_id`; không auto-publish.

### 3.5 (coach)

- Rubric v3.0 frozen server-side (8+20+30+12+10+20=100) — model không
  được tự đặt max; sum tiêu chí phải khớp `total`; evidenceRefs phải
  trỏ id thật trong input; label ngoài enum → reject; JSON thiếu →
  issue, không bịa justification.
- Coach chỉ đọc — không có apply path (route từ chối assistant≠renderer).

### 3.6 (UI + e2e)

- Admin tab AI: enable/disable/endpoint/model/key (masked, không echo),
  test connection, clear key riêng.
- Canvas AI panel: consent reset mỗi run, SSE qua fetch (Bearer không
  đi qua EventSource), stream hủy được, preview diff có giá trị scalar,
  warning checkbox, apply explicit, callback adopt draft pointers —
  publish vẫn tay.
- Dynamic text chỉ qua `textContent`/text nodes — invalid model output
  render là diagnostic text thuần (e2e kiểm chứng không apply được).

## Review độc lập

Round review Codex đến round 4 (commit `0299855`) đã xong và xanh toàn
bộ gate trước khi vào Phase 3; round 5 dispatch nhưng proxy Codex chết
giữa chừng (HTTP 429 quota) — không phải lỗi code. Phase 3 tự kiểm qua
TDD đỏ→xanh từng task + full suite + e2e ở trên.

## Giới hạn đã biết / còn mở

- **Chất lượng model local chưa được nghiệm thu** — cần endpoint nội bộ
  operator-approved + chạy 12 fixture trong `docs/evaluation/canvas-ai.md`
  rồi reviewer business duyệt. Gate này đang BLOCKED, không phải PASS.
- Preview store là in-process: đổi instance giữa stage→apply mất preview
  (by design — deploy single container; restart sweep đánh interrupted).
- `AI_ALLOW_HTTP` cần giữ `false` ở mọi deploy thật — chỉ loopback test.
