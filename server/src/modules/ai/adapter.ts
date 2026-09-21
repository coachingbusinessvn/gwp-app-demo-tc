import { AppError } from "../../shared/errors.js";

/**
 * Local chat-completions adapter (task 3.2, spec §7.1/§7.3): the ONLY code
 * path that talks to the customer-hosted AI endpoint. It is deliberately
 * narrow — one tested protocol shape (POST {base}/chat/completions,
 * OpenAI-style messages), streaming-first with a bounded non-stream
 * fallback, and no tools/functions — the model generates text, it can
 * never act.
 *
 * Safety contract:
 * - redirect:"manual" + an explicit 3xx refusal: an allowlisted endpoint
 *   must not bounce the AI client (and its bearer) to a different host.
 * - One AbortController unifies the caller signal and the timeout clock;
 *   whichever fires wins, and the upstream socket is aborted either way.
 *   The timeout uses setTimeout so tests can drive it with a fake clock.
 * - The response body is byte-capped as it streams — a runaway upstream
 *   is cut off, not buffered whole.
 * - Usage metadata is passed through only when the endpoint reports it;
 *   token counts are never estimated or fabricated (spec §7.3).
 * - Upstream error bodies are never echoed — errors carry a stable AI_*
 *   code plus the upstream HTTP status, nothing more.
 * - The API key is sent only as the Authorization bearer of THIS request
 *   to the allowlisted baseUrl — it is never logged and never in a URL.
 */

export const AI_AUTH_FAILED = "AI_AUTH_FAILED";
export const AI_BAD_RESPONSE = "AI_BAD_RESPONSE";
export const AI_BUSY = "AI_BUSY";
export const AI_CANCELLED = "AI_CANCELLED";
export const AI_OUTPUT_TOO_LARGE = "AI_OUTPUT_TOO_LARGE";
export const AI_REDIRECT_DENIED = "AI_REDIRECT_DENIED";
export const AI_TIMEOUT = "AI_TIMEOUT";
export const AI_UNAVAILABLE = "AI_UNAVAILABLE";

/** Hard byte cap on the upstream response body (streamed or not). */
export const AI_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface AiAdapterConfig {
  /** Normalized allowlisted base URL, e.g. "https://llm.internal:8443/v1". */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  maxOutputTokens: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteResult {
  text: string;
  /** Pass-through usage when the endpoint reports it — else undefined. */
  usage?: { inputTokens: number; outputTokens: number };
  /** true when the upstream actually answered with an SSE stream. */
  streamed: boolean;
}

const TIMEOUT = Symbol("ai-timeout");
const CANCELLED = Symbol("ai-cancelled");

function fail(status: number, code: string, message: string): never {
  throw new AppError(status, code, message);
}

function mapUpstreamStatus(status: number): never {
  if (status === 401 || status === 403)
    fail(502, AI_AUTH_FAILED, "Endpoint AI từ chối key — kiểm tra lại BYOK");
  if (status === 429)
    fail(503, AI_BUSY, "Endpoint AI đang bận — thử lại sau");
  if (status >= 500)
    fail(503, AI_UNAVAILABLE, "Endpoint AI tạm thời không sẵn sàng");
  fail(
    502,
    AI_BAD_RESPONSE,
    `Endpoint AI trả status ${status} — kiểm tra model/request`,
  );
}

function mapUsage(raw: unknown): CompleteResult["usage"] {
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const input = Number(u?.prompt_tokens);
  const output = Number(u?.completion_tokens);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { inputTokens: input, outputTokens: output };
}

interface SseEvent {
  data: string;
}

/** Incremental SSE parser: feed bytes, get complete events back. */
function createSseParser(
  onEvent: (e: SseEvent) => void,
): (chunk: string, flush?: boolean) => void {
  let buf = "";
  let dataLines: string[] = [];
  const dispatch = () => {
    if (dataLines.length > 0) {
      onEvent({ data: dataLines.join("\n") });
      dataLines = [];
    }
  };
  return (chunk, flush = false) => {
    buf += chunk;
    let nl;
    while ((nl = buf.search(/\r?\n/)) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === "\r" ? 2 : 1));
      if (line === "") {
        dispatch();
      } else if (line.startsWith("data:")) {
        // One optional leading space after the colon per the SSE grammar.
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // Other fields (event:/id:/retry:/comments) carry no content — skip.
    }
    if (flush) {
      if (buf !== "") {
        const line = buf;
        buf = "";
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      dispatch();
    }
  };
}

export async function complete(opts: {
  config: AiAdapterConfig;
  messages: ChatMessage[];
  maxOutputTokens: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  /** Request an SSE stream (default true); false asks for one JSON body. */
  stream?: boolean;
}): Promise<CompleteResult> {
  const { config, messages, maxOutputTokens, onDelta } = opts;
  const stream = opts.stream ?? true;

  // Defense in depth: even if settings validation were bypassed, a baseUrl
  // carrying credentials never reaches the wire.
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    fail(500, AI_BAD_RESPONSE, "Cấu hình baseUrl AI không hợp lệ");
  }
  if (base.username !== "" || base.password !== "")
    fail(500, AI_BAD_RESPONSE, "baseUrl AI không được chứa credentials");
  const url = new URL(
    "chat/completions",
    base.toString().replace(/\/?$/, "/"),
  );

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(TIMEOUT),
    Math.max(1, config.timeoutSeconds) * 1000,
  );
  const onClientAbort = () => ctrl.abort(CANCELLED);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(CANCELLED);
    else opts.signal.addEventListener("abort", onClientAbort, { once: true });
  }
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          // role+content only — no tools/functions ever (spec §7.2).
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          max_tokens: maxOutputTokens,
          stream,
        }),
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        if (ctrl.signal.reason === TIMEOUT)
          fail(504, AI_TIMEOUT, "Endpoint AI quá thời gian chờ");
        fail(499, AI_CANCELLED, "Đã hủy yêu cầu AI");
      }
      fail(503, AI_UNAVAILABLE, "Không kết nối được endpoint AI");
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      fail(
        502,
        AI_REDIRECT_DENIED,
        "Endpoint AI trả redirect — bị từ chối theo chính sách",
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      mapUpstreamStatus(response.status);
    }
    if (!response.body) fail(502, AI_BAD_RESPONSE, "Endpoint AI trả body rỗng");

    const contentType = response.headers.get("content-type") ?? "";
    const reader = response.body.getReader();
    let received = 0;
    let text = "";
    let usage: CompleteResult["usage"];

    const readAll = async (
      onChunk: (decoded: string, flush?: boolean) => void,
      shouldStop?: () => boolean,
    ) => {
      const decoder = new TextDecoder("utf-8");
      for (;;) {
        if (ctrl.signal.aborted) {
          if (ctrl.signal.reason === TIMEOUT)
            fail(504, AI_TIMEOUT, "Endpoint AI quá thời gian chờ");
          fail(499, AI_CANCELLED, "Đã hủy yêu cầu AI");
        }
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch (err) {
          // An abort mid-read rejects with AbortError — remap to the
          // stable AI_* code before it can leak as a raw DOMException.
          if (ctrl.signal.aborted) {
            if (ctrl.signal.reason === TIMEOUT)
              fail(504, AI_TIMEOUT, "Endpoint AI quá thời gian chờ");
            fail(499, AI_CANCELLED, "Đã hủy yêu cầu AI");
          }
          throw err;
        }
        const { done, value } = chunk;
        if (done || value === undefined) break;
        received += value.byteLength;
        if (received > AI_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          fail(
            502,
            AI_OUTPUT_TOO_LARGE,
            "Endpoint AI trả output vượt giới hạn",
          );
        }
        onChunk(decoder.decode(value, { stream: true }));
        if (shouldStop?.()) {
          // [DONE] or terminal event — stop consuming and release the
          // upstream socket; anything after it is not ours to read.
          await reader.cancel().catch(() => {});
          break;
        }
      }
      onChunk(decoder.decode(), true);
    };

    if (contentType.includes("text/event-stream")) {
      let malformed = false;
      let doneSeen = false;
      const feed = createSseParser((e) => {
        const data = e.data.trim();
        if (data === "[DONE]") {
          doneSeen = true;
          return;
        }
        if (doneSeen) return;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          malformed = true;
          return;
        }
        const c = chunk as {
          choices?: {
            delta?: { content?: unknown };
            message?: { content?: unknown };
          }[];
          usage?: unknown;
        };
        const piece = c?.choices?.[0]?.delta?.content;
        if (typeof piece === "string" && piece !== "") {
          text += piece;
          onDelta?.(piece);
        }
        if (c?.usage !== undefined) usage = mapUsage(c.usage);
      });
      await readAll(feed, () => doneSeen);
      if (malformed)
        fail(502, AI_BAD_RESPONSE, "Endpoint AI trả SSE không hợp lệ");
      return { text, usage, streamed: true };
    }

    if (contentType.includes("application/json")) {
      let raw = "";
      await readAll((chunk) => {
        raw += chunk;
      });
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch {
        fail(502, AI_BAD_RESPONSE, "Endpoint AI trả JSON không hợp lệ");
      }
      const c = doc as {
        choices?: { message?: { content?: unknown } }[];
        usage?: unknown;
      };
      const content = c?.choices?.[0]?.message?.content;
      if (typeof content !== "string")
        fail(502, AI_BAD_RESPONSE, "Endpoint AI trả JSON thiếu choices");
      usage = mapUsage(c?.usage);
      return { text: content, usage, streamed: false };
    }

    await reader.cancel().catch(() => {});
    fail(
      502,
      AI_BAD_RESPONSE,
      `Endpoint AI trả content-type không hỗ trợ`,
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onClientAbort);
  }
  // Unreachable — every branch above returns or throws; the explicit throw
  // keeps the control-flow honest for the compiler.
  fail(500, AI_BAD_RESPONSE, "Đường điều khiển không mong đợi");
}
