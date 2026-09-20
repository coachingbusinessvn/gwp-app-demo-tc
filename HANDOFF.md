# Handoff — Phase 2 gate-review loop

Date: 2026-09-21. Branch: `feat/real-app-design`. HEAD: `09d0cdc`.

## Where things stand

Phase 2 (canvas + pilot) is implemented and locally verified. Three rounds of
Codex `gpt-5.6-sol` high-reasoning review have run; round 3's four Important
findings are fixed in `09d0cdc`. **Round 4 review is dispatched but blocked:**
the local Codex proxy account pool (`http://localhost:53936`) returns
`503 auth_unavailable: No available account` — an auth/quota issue on the
user's side ("Check account pool diagnostics in Cockpit Tools"). Not a code
problem. Re-dispatch once an account is back.

## Round-4 review command

```bash
cd /Volumes/SS/projects/gwp-app-demo-tc
nohup codex exec -m gpt-5.6-sol -c model_reasoning_effort=high \
  --dangerously-bypass-approvals-and-sandbox \
  -C /Volumes/SS/projects/gwp-app-demo-tc \
  -o /tmp/codex-round4-last.md \
  "$(cat /tmp/codex-round4-prompt.txt)" > /tmp/codex-round4-full.log 2>&1 &
```

The prompt file `/tmp/codex-round4-prompt.txt` still exists; regenerate it
from git history/session if gone — it asks Codex to verify the four fixes
adversarially, re-scan the whole `910546d..HEAD` Phase 2 range, run all gates,
and end with `Verdict: SHIP|NEEDS-FIXES` + findings tagged
Critical/Important/Minor with file:line + repro.

## Round-3 fixes landed in `09d0cdc`

1. **Unload overwrite** (`web/canvas/editor.js` `bindUnload`): the unsent body
   is dispatched synchronously via keepalive PUT at the **current** revision N —
   never speculative N+1, never through a `.then()` continuation. Server CAS
   (company lock + `FOR UPDATE` + revision predicate in `saveDraft`) makes a
   same-revision PUT unable to overwrite a committed N+1. The dispatch is gated
   on `unsent` (deepEqual vs `lastSentBody`), not `saveState` — `schedule()`
   resets the label to `"dirty"` on every edit, so a state-label gate was dead
   code exactly when it mattered. `autosave.flush()` still runs for pipeline
   coherence on a canceled unload.
2. **Untrusted versioned imports** (`web/canvas/model.js` `sanitizeBody`
   untrusted path): object-valued string fields, `assignee_user_id` /
   `measurement` on wrong row types, malformed measurement objects (8 keys
   validated, no unknown nested keys, real calendar date), non-RFC4122 uuids
   (`isUuid` tightened to match zod), impossible dates, bad enums, non-array
   containers, and unknown keys at every level are all dropped/coerced **with
   warnings**. Regression test asserts the adapted body passes
   `CanvasBodySchema.safeParse` (tests/unit/canvas-model.test.ts).
3. **Measurement series** (`shared/canvas/measurement.ts`): `metricKey` is now
   the `[metricId, definitionRevision, unit, baseline, target]` quintuple — a
   re-baselined metric is a separate series; no point is scored against foreign
   endpoints.
4. **Uniform 404 ordering** (`server/src/modules/canvas/routes.ts` +
   `service.ts` `assertCanvasAccess`): draft/publish/restore/transfer/export
   gate subject access **before** envelope/format validation — denied+malformed
   → 404, authorized+malformed → 400 (both directions tested in
   `tests/integration/canvas-access.test.ts`).

## Last verified gates (on `09d0cdc`)

| Check | Result |
|---|---|
| `npm test` | 321/321 |
| `npm run typecheck` | 0 errors |
| `npm run build` | clean, 32 files |
| `npm run test:e2e` | 22/22 |
| `git diff --check` | clean |

## Resume checklist

1. Restore a Codex account in the proxy pool, re-run the command above.
2. If verdict is SHIP → Phase 2 done; report to user, stop.
3. If NEEDS-FIXES → fix findings (TDD where practical), re-run all gates,
   commit, dispatch round 5. Repeat until SHIP.
4. e2e caveat: Playwright `reuseExistingServer` — kill stale `serve.ts`
   processes on :8901 before a fresh run or stale DB state produces
   phantom failures.
5. Codex CLI caveat: `codex exec` output may truncate with `tail` — always
   pass `-o <file>` for the final message.

## Task queue state

All Phase 2 subtasks (2.1–2.7) sit at done gates in the 1DevTool Tasks queue
awaiting user review. Phase 3 (local AI BYOK) is next once gates clear.
