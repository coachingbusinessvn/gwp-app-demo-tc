import { describe, expect, it, vi } from "vitest";

// The module is plain browser JS — declare the surface the tests use.
import { createAutosave } from "../../web/canvas/autosave.js";

/**
 * Gate-review fix (phase 2): an in-flight save must NOT flip the state to
 * "saved" while a NEWER edit is still only scheduled on the debounce
 * timer — otherwise unload/export/publish (which gate on the state) see a
 * false-saved window and can skip flushing genuinely-unsaved content.
 */

function make() {
  const states: string[] = [];
  const pending: Array<{
    body: unknown;
    resolve: (r: { status: number }) => void;
  }> = [];
  const autosave = createAutosave({
    debounceMs: 50,
    send: (body: unknown) =>
      new Promise<{ status: number }>((res) =>
        pending.push({ body, resolve: res }),
      ),
    setState: (s: string) => states.push(s),
  });
  return { autosave, states, pending };
}

describe("autosave — saved only when nothing newer is pending", () => {
  it("an edit scheduled during an in-flight save keeps the state dirty", async () => {
    vi.useFakeTimers();
    try {
      const { autosave, states, pending } = make();
      const body = { v: 0 };
      autosave.schedule(() => body);
      await vi.advanceTimersByTimeAsync(60); // save 1 in flight
      expect(pending).toHaveLength(1);
      expect(states).toEqual(["dirty", "saving"]);

      // A newer edit arrives while save 1 is still in flight.
      autosave.schedule(() => ({ v: 1 }));
      // Save 1 resolves — the pending timer means work is still owed.
      pending[0].resolve({ status: 200 });
      await vi.advanceTimersByTimeAsync(0);

      expect(states[states.length - 1]).toBe("dirty"); // never false-saved

      // The debounce fires → save 2 → resolves → NOW it's saved.
      await vi.advanceTimersByTimeAsync(60);
      expect(pending).toHaveLength(2);
      pending[1].resolve({ status: 200 });
      await vi.advanceTimersByTimeAsync(0);
      expect(states[states.length - 1]).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a queued mid-flight save does not produce a premature saved either", async () => {
    const { autosave, states, pending } = make();
    autosave.schedule(() => ({ v: 0 }));
    // flush() clears the timer and starts the request now — send() is
    // invoked on a microtask, so settle once before counting.
    const f1 = autosave.flush();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // Trigger a second send while the first is in flight (the queue path).
    const f2 = autosave.flush();
    pending[0].resolve({ status: 200 });
    // f1's promise covers the drained follow-up save — don't await it
    // before resolving pending[1] (that would deadlock the test).
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(states).not.toContain("saved");
    pending[1].resolve({ status: 200 });
    await f1;
    await f2;
    await vi.waitFor(() => expect(states[states.length - 1]).toBe("saved"));
  });

  it("forwards flush opts to send — including the queued follow-up on unload", async () => {
    const seen: Array<{ keepalive?: boolean } | undefined> = [];
    const pending: Array<{ resolve: (r: { status: number }) => void }> = [];
    const autosave = createAutosave({
      debounceMs: 50,
      send: (_body: unknown, opts?: { keepalive?: boolean }) => {
        seen.push(opts);
        return new Promise<{ status: number }>((res) =>
          pending.push({ resolve: res }),
        );
      },
      setState: () => {},
    });

    // An in-flight save, then an unload flush carrying keepalive — the
    // queued follow-up must inherit the transport opts (it is the newest
    // body and the one that must survive teardown).
    autosave.schedule(() => ({ v: 0 }));
    const f = autosave.flush();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    autosave.flush(() => ({ v: 1 }), { keepalive: true });
    pending[0].resolve({ status: 200 });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(seen[1]).toEqual({ keepalive: true });
    pending[1].resolve({ status: 200 });
    await f;
  });
});
