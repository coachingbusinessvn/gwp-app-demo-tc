# Local AI (BYOK) — operator guide

Phase 3 adds a **local-only** AI integration. There is no cloud fallback:
the app only ever calls the chat-completions endpoint the operator
allowlists.

## Where to configure

Admin page → tab **AI** (`/admin.html`, owner/admin only), or the API:

- `GET /settings/ai` — public shape: `configured`, `enabled`, `baseUrl`,
  `model`, bounds. The key is never returned.
- `PUT /settings/ai` — `{enabled, baseUrl, model, apiKey?, timeoutSeconds,
  maxOutputTokens}`. Omitting `apiKey` preserves the stored key.
- `DELETE /settings/ai/key` — explicit credential clear.
- `POST /settings/ai/test` — connection probe with a synthetic prompt
  (`"Reply with the word OK."`); no customer data is ever sent by it.

Keys are stored AES-256-GCM-encrypted under `APP_KEY` in the `setting`
table; `keyVersion` rotates on replace. Audit events record
`enabled`/`model`/`key_version` metadata only.

## Endpoint requirements

- `baseUrl` must be in **`AI_ALLOWED_HOSTS`** (comma-separated
  `host[:port]` entries, exact match — set it in `.env`/Compose).
- HTTPS by default; plain HTTP is refused unless `AI_ALLOW_HTTP=true`
  (loopback/dev only).
- Credentials in the URL, query strings and fragments are rejected.
- The endpoint must accept `POST {baseUrl}/chat/completions` with
  `Authorization: Bearer <key>` and OpenAI-style `{messages, stream}`
  bodies. SSE streaming and plain JSON responses are both supported.

## Gateway hygiene (operator responsibility)

- Terminate TLS at the internal gateway; keep `AI_ALLOW_HTTP` unset in
  any real deployment.
- Disable request-body logging on the gateway — canvas content and
  session notes flow through it.
- Size the model context to a full canonical canvas Markdown (~tens of
  KB) plus `maxOutputTokens` (default cap 8192, configurable).

## Run lifecycle (what users see)

1. Canvas editor → "Trợ lý AI nội bộ" card → tick consent (re-arms each
   run) → "Chạy AI".
2. Progress streams live; "Hủy chạy AI" cancels upstream work.
3. The preview is held in memory for **15 minutes**, readable only by
   the run creator — it is never persisted.
4. **Renderer**: diff + issues; warnings must be ticked one by one;
   "Áp dụng vào bản nháp" writes the draft with `source="ai"` provenance
   and refuses if the draft moved meanwhile (`409 AI_BASE_CHANGED`).
   Publish stays a separate human step.
5. **Coach**: read-only rubric v3.0 grading + labelled advice — it can
   never modify the canvas.

## Failure surface

Stable codes only, safe to render: `AI_NOT_CONFIGURED`, `AI_DISABLED`,
`AI_CONSENT_REQUIRED`, `AI_BUSY` (max 2 active runs/company),
`AI_IDEMPOTENCY_CONFLICT`, `AI_TIMEOUT`, `AI_CANCELLED`,
`AI_DESTINATION_NOT_ALLOWED`, `AI_BAD_RESPONSE`, `AI_BASE_CHANGED`,
`AI_PROPOSAL_INVALID`, `AI_WARNINGS_UNACCEPTED`, `PREVIEW_EXPIRED`,
`AI_INPUT_TOO_LARGE`, `AI_RUN_NOT_READY`, `AI_RUN_FINISHED`.

A process restart marks leftover queued/running rows `interrupted` —
no phantom running work survives a deploy.
