/**
 * web/canvas/autosave.js — debounced, serialized, revision-aware draft
 * save loop (task 2.5).
 *
 * Contract:
 *   - At most ONE save request in flight; requests during a flight are
 *     queued, not overlapped (serialized writes).
 *   - The revision never advances locally — the `send` callback owns the
 *     server round-trip and advances it only from a 200 response.
 *   - 409 → setState("conflict") once, autosave freezes (freeze()); the
 *     editor owns the conflict UX and may thaw() after the user reloads
 *     the latest draft.
 *   - Other non-OK / network errors → setState("error") and stop until
 *     the user retries (retry()) or edits again (schedule()).
 *   - flush() resolves after the queue fully drains — callers that need
 *     the settled revision (publish) await it.
 *
 * `send(body)` performs the actual fetch and returns {status}; the
 * caller supplies it so the module stays unit- and test-friendly.
 */
export function createAutosave({ debounceMs = 800, send, setState }) {
  let timer = null;
  let inFlight = false;
  let queued = false;
  let frozen = false;
  let running = null;
  let getBody = null;

  function run() {
    if (inFlight) {
      queued = true;
      return running;
    }
    inFlight = true;
    setState("saving");
    running = Promise.resolve()
      .then(() => send(getBody ? getBody() : null))
      .then((r) => {
        const status = r && r.status;
        if (status === 409) {
          frozen = true;
          setState("conflict");
        } else if (status && status >= 200 && status < 300) {
          setState("saved");
        } else {
          setState("error");
        }
      })
      .catch(() => setState("error"))
      .then(() => {
        inFlight = false;
        if (queued && !frozen) {
          queued = false;
          return run(); // drain: the awaited promise covers the follow-up
        }
        queued = false;
        running = null;
      });
    return running;
  }

  const api = {
    /** Mark dirty + schedule a save (debounced; no-op while frozen). */
    schedule(bodyGetter) {
      if (frozen) return;
      if (bodyGetter) getBody = bodyGetter;
      setState("dirty");
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    },
    /**
     * Save NOW and resolve after the queue drains (retry button,
     * publish's settle step, beforeunload's best-effort flush).
     */
    flush(bodyGetter) {
      if (frozen) return Promise.resolve();
      if (bodyGetter) getBody = bodyGetter;
      clearTimeout(timer);
      return Promise.resolve(run());
    },
    /** Explicit user retry after an error — same path as flush. */
    retry() {
      return api.flush();
    },
    /** Freeze after conflict until the editor reloads the latest draft. */
    freeze() {
      frozen = true;
      clearTimeout(timer);
      queued = false;
    },
    thaw() {
      frozen = false;
    },
    isFrozen() {
      return frozen;
    },
    dispose() {
      clearTimeout(timer);
      frozen = true;
    },
  };
  return api;
}
