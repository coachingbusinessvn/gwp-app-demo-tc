import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Fake local LLM endpoint for adapter tests (task 3.2): a real HTTP server
 * on an ephemeral loopback port so the adapter's fetch/SSE/timeout paths
 * run against a live socket — no fetch mocking.
 *
 * Request capture is redacted by construction: `authorization` is recorded
 * as a presence flag, never its value — a captured request must never carry
 * a credential into a test log. The server itself can enforce an expected
 * bearer key (`expectedApiKey`) and answers 401 on mismatch, which is how
 * tests prove the adapter sent the right secret without ever holding it.
 *
 * Response scripting is a FIFO queue (enqueue) plus a default. SSE chunks
 * are raw Buffer/string frames — tests control byte boundaries to split
 * UTF-8 codepoints and SSE lines mid-frame.
 */
export interface CapturedRequest {
  method: string;
  url: string;
  /** `authorization` appears only as the literal "<present>" flag. */
  headers: Record<string, string>;
  body: unknown;
  /** set when the client aborted the socket mid-request/response. */
  aborted: boolean;
}

export type FakeLlmResponse =
  | { kind: "sse"; frames: (string | Buffer)[]; status?: number }
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "status"; status: number; body?: string }
  | { kind: "redirect"; location: string }
  | { kind: "hang" }
  | { kind: "custom"; handle: (req: IncomingMessage, res: ServerResponse) => void };

export interface FakeLlm {
  /** e.g. "http://127.0.0.1:54321" — the adapter baseUrl in tests. */
  url: string;
  requests: CapturedRequest[];
  enqueue(r: FakeLlmResponse): void;
  close(): Promise<void>;
}

const DEFAULT_RESPONSE: FakeLlmResponse = {
  kind: "sse",
  frames: [
    'data: {"choices":[{"delta":{"content":"pong"}}]}\n\n',
    "data: [DONE]\n\n",
  ],
};

export async function fakeLlm(options?: {
  expectedApiKey?: string;
  respondWith?: FakeLlmResponse;
  /** Fixed port for e2e (the app server's allowlist is set before the
   *  test knows a port). Default 0 = ephemeral. */
  port?: number;
}): Promise<FakeLlm> {
  const requests: CapturedRequest[] = [];
  const queue: FakeLlmResponse[] = [];
  const defaultResponse = options?.respondWith ?? DEFAULT_RESPONSE;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "authorization") {
          headers[k] = v === undefined ? "<absent>" : "<present>";
        } else {
          headers[k] = Array.isArray(v) ? v.join(",") : (v ?? "");
        }
      }
      let body: unknown = undefined;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers,
        body,
        aborted: false,
      };
      req.on("aborted", () => {
        captured.aborted = true;
      });
      res.on("close", () => {
        if (!res.writableFinished) captured.aborted = true;
      });
      requests.push(captured);

      if (
        options?.expectedApiKey !== undefined &&
        req.headers.authorization !== `Bearer ${options.expectedApiKey}`
      ) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }

      const script = queue.length > 0 ? queue.shift()! : defaultResponse;
      switch (script.kind) {
        case "redirect":
          res.writeHead(302, { Location: script.location });
          res.end();
          return;
        case "hang":
          // Never respond — timeout tests drive the clock.
          return;
        case "status":
          res.writeHead(script.status, { "Content-Type": "text/plain" });
          res.end(script.body ?? "");
          return;
        case "json":
          res.writeHead(script.status ?? 200, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(script.body));
          return;
        case "sse":
          res.writeHead(script.status ?? 200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          for (const frame of script.frames) res.write(frame);
          res.end();
          return;
        case "custom":
          script.handle(req, res);
          return;
      }
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(options?.port ?? 0, "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    enqueue: (r) => queue.push(r),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
