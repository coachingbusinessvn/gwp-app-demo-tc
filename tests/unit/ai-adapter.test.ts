import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm.js";
import {
  complete,
  AI_AUTH_FAILED,
  AI_BAD_RESPONSE,
  AI_BUSY,
  AI_CANCELLED,
  AI_OUTPUT_TOO_LARGE,
  AI_TIMEOUT,
  AI_UNAVAILABLE,
  AI_REDIRECT_DENIED,
  type AiAdapterConfig,
} from "../../server/src/modules/ai/adapter.js";

/**
 * Task 3.2 — local chat-completions adapter (spec §7.1/§7.3).
 * Contract: bounded (timeout, byte cap, max_tokens), cancellable
 * (client abort closes the upstream connection), redirect-proof
 * (redirect:"manual" + explicit refusal — an allowlisted host must not
 * bounce the AI client to a different destination), and content-only
 * (never tools/functions, never an invented usage count).
 */

function configFor(llm: FakeLlm, extra?: Partial<AiAdapterConfig>): AiAdapterConfig {
  return {
    baseUrl: `${llm.url}/v1`,
    apiKey: "local-secret",
    model: "pilot",
    timeoutSeconds: 180,
    maxOutputTokens: 8192,
    ...extra,
  };
}

let llm: FakeLlm | undefined;
afterEach(async () => {
  await llm?.close().catch(() => {});
  llm = undefined;
  vi.useRealTimers();
});

describe("local AI adapter (task 3.2)", () => {
  it("streams SSE deltas split mid-UTF8 and mid-line, then stops at [DONE]", async () => {
    // "Xin chào" — the 'à' (U+00E0, 2 UTF-8 bytes) is split across frames,
    // and one SSE line is split mid-payload. A naive per-chunk decoder
    // would corrupt the text or the event boundary.
    const e0 = Buffer.from("Xin chào", "utf8");
    const part1 = e0.subarray(0, e0.length - 1); // drop last byte of 'à'
    const part2 = e0.subarray(e0.length - 1);
    llm = await fakeLlm({
      respondWith: {
        kind: "sse",
        frames: [
          Buffer.concat([Buffer.from('data: {"choices":[{"delta":{"content":"'), part1]),
          Buffer.concat([part2, Buffer.from('"}}]}\n\nda')]),
          Buffer.from('ta: [DONE]\n\ndata: {"choices":[{"delta":{"content":"after-done"}}]}\n\n'),
        ],
      },
    });
    const deltas: string[] = [];
    const r = await complete({
      config: configFor(llm),
      messages: [{ role: "user", content: "Kiểm tra" }],
      maxOutputTokens: 100,
      onDelta: (d) => deltas.push(d),
    });
    expect(r.text).toBe("Xin chào");
    expect(deltas.join("")).toBe("Xin chào");
    expect(llm.requests).toHaveLength(1);
  });

  it("sends only role/content messages with bearer auth — no tools, no extra fields", async () => {
    llm = await fakeLlm({ expectedApiKey: "local-secret" });
    const r = await complete({
      config: configFor(llm),
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Kiểm tra" },
      ],
      maxOutputTokens: 100,
    });
    expect(r.text).toBe("pong");
    const req = llm.requests[0];
    expect(req.url).toBe("/v1/chat/completions");
    const body = req.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("functions");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.model).toBe("pilot");
    expect(body.max_tokens).toBe(100);
    expect(body.stream).toBe(true);
    const msgs = body.messages as Record<string, unknown>[];
    expect(Object.keys(msgs[0]).sort()).toEqual(["content", "role"]);
    // Capture is redacted by construction — assert presence, not value.
    expect(req.headers.authorization).toBe("<present>");
  });

  it("a wrong key gets the upstream 401 → AI_AUTH_FAILED", async () => {
    llm = await fakeLlm({ expectedApiKey: "the-real-key" });
    await expect(
      complete({
        config: configFor(llm),
        messages: [{ role: "user", content: "x" }],
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({ code: AI_AUTH_FAILED });
  });

  it("parses a bounded non-stream JSON response incl. usage", async () => {
    llm = await fakeLlm({
      respondWith: {
        kind: "json",
        body: {
          choices: [{ message: { role: "assistant", content: "full text" } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        },
      },
    });
    const r = await complete({
      config: configFor(llm),
      messages: [{ role: "user", content: "x" }],
      maxOutputTokens: 50,
    });
    expect(r.text).toBe("full text");
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
  });

  it("maps 429→AI_BUSY, 5xx→AI_UNAVAILABLE, other non-2xx→AI_BAD_RESPONSE", async () => {
    llm = await fakeLlm();
    for (const [status, code] of [
      [429, AI_BUSY],
      [500, AI_UNAVAILABLE],
      [503, AI_UNAVAILABLE],
      [400, AI_BAD_RESPONSE],
    ] as const) {
      llm.enqueue({ kind: "status", status });
      await expect(
        complete({
          config: configFor(llm),
          messages: [{ role: "user", content: "x" }],
          maxOutputTokens: 10,
        }),
      ).rejects.toMatchObject({ code });
    }
    // The adapter error must never echo an upstream body verbatim.
    llm.enqueue({ kind: "status", status: 500, body: "SECRET-INTERNAL-TRACE" });
    const err = await complete({
      config: configFor(llm),
      messages: [{ role: "user", content: "x" }],
      maxOutputTokens: 10,
    }).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain("SECRET-INTERNAL-TRACE");
  });

  it("refuses a redirect — the allowlisted host cannot bounce the client elsewhere", async () => {
    llm = await fakeLlm();
    llm.enqueue({ kind: "redirect", location: "http://evil.internal/steal" });
    await expect(
      complete({
        config: configFor(llm),
        messages: [{ role: "user", content: "x" }],
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({ code: AI_REDIRECT_DENIED });
    // The redirect target is never contacted — only the first request exists.
    expect(llm.requests).toHaveLength(1);
  });

  it("caps an oversized SSE stream instead of buffering it whole", async () => {
    // >1 MiB of delta frames — the byte cap must trip before the text lands.
    const big = "x".repeat(64 * 1024);
    llm = await fakeLlm({
      respondWith: {
        kind: "sse",
        frames: Array.from(
          { length: 20 },
          () => `data: {"choices":[{"delta":{"content":"${big}"}}]}\n\n`,
        ),
      },
    });
    await expect(
      complete({
        config: configFor(llm),
        messages: [{ role: "user", content: "x" }],
        maxOutputTokens: 8192,
      }),
    ).rejects.toMatchObject({ code: AI_OUTPUT_TOO_LARGE });
  });

  it("times out at the configured bound (fake clock) with AI_TIMEOUT", async () => {
    llm = await fakeLlm({ respondWith: { kind: "hang" } });
    vi.useFakeTimers();
    const task = complete({
      config: configFor(llm, { timeoutSeconds: 180 }),
      messages: [{ role: "user", content: "x" }],
      maxOutputTokens: 10,
    });
    const assertion = expect(task).rejects.toMatchObject({
      code: AI_TIMEOUT,
    });
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
  });

  it("client abort → AI_CANCELLED and the upstream connection closes", async () => {
    // A slowly-streaming upstream: first delta lands, then the client aborts
    // — deterministic (the request has reached the server before abort).
    llm = await fakeLlm({
      respondWith: {
        kind: "custom",
        handle: (_req, res) => {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"chunk1"}}]}\n\n');
          // then hangs — never ends the stream
        },
      },
    });
    const controller = new AbortController();
    const task = complete({
      config: configFor(llm),
      messages: [{ role: "user", content: "x" }],
      maxOutputTokens: 10,
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    await expect(task).rejects.toMatchObject({ code: AI_CANCELLED });
    await vi.waitFor(() => {
      expect(llm!.requests[0]?.aborted).toBe(true);
    });
  });

  it("malformed SSE data → AI_BAD_RESPONSE, not a crash", async () => {
    llm = await fakeLlm({
      respondWith: {
        kind: "sse",
        frames: ['data: {"choices": BROKEN\n\n'],
      },
    });
    await expect(
      complete({
        config: configFor(llm),
        messages: [{ role: "user", content: "x" }],
        maxOutputTokens: 10,
      }),
    ).rejects.toMatchObject({ code: AI_BAD_RESPONSE });
  });
});
