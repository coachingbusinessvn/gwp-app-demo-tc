/**
 * web/ai/stream.js — fetch-based SSE reader for AI run events (task 3.6).
 *
 * EventSource cannot send a Bearer token (and putting one in the URL would
 * leak it into logs), so progress is read from the authenticated
 * apiFetch response body instead. The wire format is `data: <json>\n\n`
 * frames emitted by GET /ai/runs/:id/events.
 *
 * Aborting `signal` cancels the reader — the server treats a client
 * disconnect as a run cancel, so aborting here also stops upstream work.
 */
export async function readEvents(response, onEvent, signal) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const abort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  try {
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            onEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* a partial frame is ignored — the next read completes it */
          }
        }
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", abort);
  }
}
