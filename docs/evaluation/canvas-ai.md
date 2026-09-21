# Canvas AI — local-model evaluation record

Evaluation gate for Phase 3 (plan task 3.6 / exit gate). **Status:
blocked-eval pending** — no production local endpoint has been approved
yet; the numbers below are the automated safety fixtures, not a quality
claim. Per the plan, quality sign-off needs a real operator-approved
endpoint and a business reviewer; parse rate is not a quality proxy.

## Provenance (redacted)

- Model: _pending operator endpoint_ (recorded as `config_model` on each
  `ai_run` row).
- Prompt versions pinned by manifest sha256:
  `server/prompts/renderer/manifest.json` (renderer-1.0.0),
  `server/prompts/coach/manifest.json` (coach-1.0.0).
- No API key, request body, or generated text appears in this record or
  in `ai_run` rows.

## Safety fixtures — automated, all passing

Vietnamese fixtures run through the real adapter/validator stack
(`npm test -- tests/unit/ai-adapter.test.ts tests/unit/coach-output.test.ts
tests/integration/renderer.test.ts tests/integration/coach.test.ts`,
e2e `tests/e2e/ai.spec.ts`):

| # | Fixture | Expected | Result |
|---|---------|----------|--------|
| 1 | Valid canonical render (SSE) | proposal → preview → apply | PASS |
| 2 | Valid canonical render (JSON) | same | PASS |
| 3 | Prose answer, no canvas block | RENDER_NO_CANVAS issue, no apply | PASS |
| 4 | Broken markdown mid-table | parse errors in preview, apply 409 | PASS |
| 5 | Unsupported box→behavior ref | error issue, apply refused | PASS |
| 6 | Stage upgrade proposed | STAGE_CHANGED warning needs acceptance | PASS |
| 7 | New Observed Evidence proposed | OBSERVED_PROPOSED warning | PASS |
| 8 | Forged assignee_user_id | error, apply refused | PASS |
| 9 | Draft moved between run and apply | 409 AI_BASE_CHANGED | PASS |
| 10 | Permission revoked before apply | uniform 404 | PASS |
| 11 | Coach valid rubric output | validated preview | PASS |
| 12 | Coach: score over max | SCORE_OUT_OF_RANGE | PASS |
| 13 | Coach: total ≠ sum | SCORE_TOTAL_MISMATCH | PASS |
| 14 | Coach: invented evidence ref | UNKNOWN_EVIDENCE_REFERENCE | PASS |
| 15 | Coach: Fact with no source | FACT_REQUIRES_EVIDENCE | PASS |
| 16 | Coach: truncated JSON | preview diagnostic, no crash | PASS |
| 17 | Timeout / cancel / disconnect | AI_TIMEOUT / cancelled, no writes | PASS |
| 18 | Key absent/disabled/not configured | stable 503/409 codes | PASS |

## Business review

- [ ] Rubric criteria weights reviewed by the business owner (frozen
      from `Skill/canvas-coach/references/grading.md` v3.0 — not tuned).
- [ ] ≥12 real Vietnamese session fixtures run against the approved
      endpoint; per-fixture pass/fail recorded with model id + prompt
      hash; reviewer sign-off recorded in
      `docs/superpowers/evidence/phase-3.md`.
