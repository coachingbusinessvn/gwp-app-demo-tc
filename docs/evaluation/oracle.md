# ORACLE Coaching Grader — local-model evaluation record

Evaluation gate for Phase 4 (plan task 4.4). **Status: blocked-eval
pending** — no production local endpoint has been approved yet; the
numbers below are the automated safety/contract fixtures, not a quality
claim. Per the plan, quality sign-off needs a real operator-approved
endpoint and a business reviewer; schema/rubric validation is not a
quality proxy.

## Provenance (redacted)

- Rubric: `ORACLE-v3`, ported verbatim from
  `gwp_chatbot_oracle/release/knowledge/oracle-scoring-rubric.md` and the
  deterministic validator `scripts/validate_oracle_output.py`.
- Prompt bundle pinned by sha256 (recompute with
  `shasum -a 256 server/prompts/oracle/*`):
  - `instruction.md` — `6307fc31ae72692359cc149cfe3af5b6e42293e54c6e794f803e70e1512d4542`
  - `manifest.json` — `900f6e830affb786260096ac479e853633590b54960ea52680e6d2b7f656fe5a`
  - `rubric.json` — `c0b704530a75fe4dfc7536c3a60b61680decf60b8c13c92f62e7464b8b940080`
- Fixture transcript/report:
  `tests/fixtures/ai/oracle-cases.json` — `c51d6d06f3ca8d0e4f211f2db5066779514ab57cbcbd0548fc34c7c0494beacc`
- No API key, raw prompt, transcript, or generated report appears in
  this record or in `ai_run` rows (transcripts are ephemeral by design).

## Contract fixtures — automated, all passing

Driven through the real driver/validator/route stack
(`npm test -- tests/integration/grader.test.ts
tests/integration/report-access.test.ts
tests/integration/report-sharing.test.ts tests/integration/ai-runs.test.ts
tests/integration/renderer.test.ts`; browser path
`npx playwright test tests/e2e/coaching.spec.ts`):

| # | Case | Expected | Result |
|---|------|----------|--------|
| 1 | Valid Vietnamese transcript → ORACLE run | validated preview, six integer step scores, total = round(sum×100/60) | PASS |
| 2 | Transcript after run ends | never in DB, audit, `ai_run`, or localStorage; cleared from the field | PASS |
| 3 | Run without consent | `AI_CONSENT_REQUIRED`; consent checkbox re-arms per run | PASS |
| 4 | Fabricated quote in report | `QUOTE_NOT_IN_TRANSCRIPT` issue; preview shown but save refused | PASS |
| 5 | Total ≠ round(sum×100/60) | `TOTAL_MISMATCH` issue; save refused | PASS |
| 6 | Score outside 0–10 / non-integer | schema issue; save refused | PASS |
| 7 | Legacy label `[Suy diễn]` or unknown label | label issue; save refused | PASS |
| 8 | `[Bằng chứng trực tiếp]` line without quote | issue; save refused | PASS |
| 9 | Save without prior valid preview / foreign run / wrong assistant / restarted server | 404 or 410 — never a stored report | PASS |
| 10 | Idempotent save replay | same report row; after delete → 404 (no resurrection) | PASS |
| 11 | Missing/contradictory evidence in transcript | `[Thiếu bằng chứng]` lines retained verbatim in output | PASS |
| 12 | Report→Renderer bridge | only `priorities`/`followUp`/`nextSession` prose; labels, quotes, scores stripped; empty pick → `REPORT_BRIDGE_EMPTY` | PASS |
| 13 | ACL: sharee reads, cannot re-share; revoke denies next request; delete needs `{confirm:true}` | enforced server-side | PASS |

## Adversarial / edge coverage already exercised

- **Fabricated evidence**: quotes not present in the normalized transcript
  are rejected by the validator before preview is saveable (case 4, 8).
- **Missing evidence**: steps with no observable behavior must carry
  `[Thiếu bằng chứng]`; the label is preserved end-to-end in preview,
  saved body, and rendered HTML.
- **Contradictory scores**: recomputed total is authoritative — a model
  that writes an inconsistent total fails validation, the stored report
  always carries the recomputed value.
- **Injection attempt**: report markdown is rendered through the escaping
  whitelist renderer (`renderOracleReport`) — markup in model output can
  never execute.
- **Size abuse**: transcript input > 1 MiB is refused client-side and
  server-side (`AI_INPUT_TOO_LARGE`).

## Human reviewer rubric (for business sign-off)

A qualified reviewer (ORACLE-trained coach or L&D lead) scores each
sampled real transcript's generated report on:

1. **Score defensibility** — each step score is justified by transcript
   evidence; no step is scored on absent behavior.
2. **Label honesty** — `[Diễn giải]`/`[Thiếu bằng chứng]` are used where
   evidence is indirect or absent; no silent upgrades to
   `[Bằng chứng trực tiếp]`.
3. **Quote fidelity** — every quoted span is verbatim transcript text
   (automated check is necessary but not sufficient; the reviewer
   confirms the quote supports the claim made).
4. **Actionability** — `Ưu tiên cải thiện`/`Theo dõi`/`Phiên tiếp theo`
   sections are specific, ranked, and coachable — not generic advice.
5. **Non-delegation** — the report reads as development support; it must
   never state or imply a personnel decision.

## Business review

- [ ] ≥6 real Vietnamese coaching transcripts (incl. ≥1 adversarial with
      fabricated evidence, ≥1 thin/missing evidence, ≥1 contradictory
      speaker turns) graded against the approved endpoint; per-case
      pass/fail recorded with model id + prompt sha256.
- [ ] Reviewer sign-off against the rubric above, recorded in
      `docs/superpowers/evidence/phase-4.md`.
- [ ] Drift check: prompt bundle checksums re-verified at sign-off time.
