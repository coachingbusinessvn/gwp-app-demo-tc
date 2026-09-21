# Handoff — Phase 4 (reports & delivery) complete

Date: 2026-09-21. Branch: `feat/real-app-design`. HEAD: `489cd79`.

## Where things stand

Phase 4 is implemented and locally verified — the app now covers the
full journey: coaching sessions → ephemeral-transcript ORACLE grading →
explicit save → immutable report versions → independent report ACL
(share/revoke/delete) → Renderer bridge → retention + APP_KEY rotation →
backup/restore drill + offline bundle + upgrade gate → e2e journey +
pilot benchmark.

Evidence: `docs/superpowers/evidence/phase-4.md` (per-gate mapping,
measured numbers, open exceptions). Progress ledger:
`.superpowers/sdd/2026-09-20-phase-4-reports-delivery/progress.md`.

## Open items — require human decision, not auto-waived

1. **Real local-model quality acceptance** — fake-LLM tests prove the
   plumbing only. Run the checklists in `docs/evaluation/oracle.md` and
   `docs/evaluation/canvas-ai.md` against an operator-approved local
   endpoint before customer delivery.
2. **PDF/A4 manual checklist** — `docs/operations/pilot.md` §3.
3. **Benchmark on real pilot hardware** — current numbers are from a
   12-CPU/32-GiB dev host; re-run `npm run test:performance` on the
   deployment box.
4. **Docs approval** — `phase-4.md` + the Vietnamese runbooks
   (`docs/operations/*.md`) need human sign-off per the exit gate.

## Last verified gates (on `489cd79`)

| Check | Result |
|---|---|
| `npm test` | 407/407 (34 files) |
| `npm run test:e2e` | 29/29 |
| `npm run test:performance` | PASS — p95 ≤160ms ordinary APIs, 0 errors (50 sessions, 100k versions) |
| `npm run typecheck` | 0 errors |
| `npm run build` | 42 files |
| `docker compose config` | valid |
| `npm run ops:bundle -- --no-images` | all checksums verify |
| `git diff --check` | clean |

## Conventions that matter

- E2E: real login only (`loginAs`/`apiAsPage` in `tests/helpers/browser.ts`);
  `isolateClientIp(ctx)` before login — rate limits are per-IP; the e2e
  DB (`gwp_e2e`) persists between runs — use per-run UUID idempotency keys.
- The fake LLM (`tests/helpers/fake-llm.ts`) is FIFO `enqueue` + a default
  `respondWith`; pinned to `127.0.0.1:18923` via `AI_ALLOWED_HOSTS`.
- Reporting tree: `setManager` is owner-only and rejects non-active
  subjects (`USER_NOT_ACTIVE`) — attach managers after activation.
- Restore drill always targets `gwp_restore_test`; offline bundles never
  carry customer data/secrets/model weights (`release-manifest.json` is
  the include-list).

## Task queue state

All Phase 4 tasks (4.1–4.7) are committed. Umbrella task `t-cwbh9pwvnm54x`
awaits user review of the exit-gate exceptions above before closure.
