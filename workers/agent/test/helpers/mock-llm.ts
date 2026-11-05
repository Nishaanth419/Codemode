/**
 * Scripted HTTP mocks for Groq (OpenAI-compatible) and Gemini (REST used by @google/genai).
 * Tests exercise the real provider code and the real Gemini SDK; only `fetch` is fake.
 */
export type Reply =
  | { kind: "text"; text: string }
  | { kind: "tool"; code: string; id?: string; thoughtSignature?: string }
  | { kind: "http"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "hang" } // never responds; ends only when the request is aborted (timeout)
  | { kind: "network" } // fetch rejects like a DNS / connection failure
  | { kind: "stream-error"; partial: string }; // Groq: streams some text, then an error event

export interface RecordedRequest {
  provider: "groq" | "gemini";
  url: string;
  body: any;
  headers: Record<string, string>;
}

export class MockLLM {
  readonly requests: RecordedRequest[] = [];
  private readonly queues: Record<"groq" | "gemini", Reply[]> = { groq: [], gemini: [] };
  /** Used when a queue is empty. */
  fallback: Record<"groq" | "gemini", Reply | undefined> = { groq: undefined, gemini: undefined };

  groq(...replies: Reply[]) {
    this.queues.groq.push(...replies);
    return this;
  }

  gemini(...replies: Reply[]) {
    this.queues.gemini.push(...replies);
    return this;
  }

  calls(provider: "groq" | "gemini") {
    return this.requests.filter((r) => r.provider === provider);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const provider = url.includes("generativelanguage.googleapis.com") ? "gemini" : "groq";
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => (headers[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ provider, url, body, headers });

    const reply = this.queues[provider].shift() ?? this.fallback[provider];
    if (!reply) throw new Error(`MockLLM: no scripted reply for ${provider} (request #${this.calls(provider).length})`);

    if (reply.kind === "network") {
      const err = new TypeError("fetch failed");
      (err as any).cause = { code: "ECONNREFUSED" };
      throw err;
    }
    if (reply.kind === "hang") {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (reply.kind === "stream-error") {
      const sse =
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.partial } }] })}\n\n` +
        `data: ${JSON.stringify({ error: { message: "upstream overloaded", type: "server_error", status_code: 503 } })}\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (reply.kind === "http") {
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json", ...(reply.headers ?? {}) }
      });
    }
    const stream = provider === "groq" ? body?.stream === true : url.includes("streamGenerateContent");
    return provider === "groq" ? groqResponse(reply, stream, body?.model) : geminiResponse(reply, stream);
  };
}

function groqResponse(reply: Extract<Reply, { kind: "text" | "tool" }>, stream: boolean, model = "openai/gpt-oss-120b"): Response {
  const toolCall =
    reply.kind === "tool"
      ? { id: reply.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: "codemode", arguments: JSON.stringify({ code: reply.code }) } }
      : undefined;
  if (!stream) {
    return Response.json({
      id: "chatcmpl-1",
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply.kind === "text" ? reply.text : null, tool_calls: toolCall ? [toolCall] : undefined },
          finish_reason: toolCall ? "tool_calls" : "stop"
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    });
  }
  const chunks: unknown[] = [];
  if (reply.kind === "text") {
    for (const part of reply.text.match(/.{1,8}/gs) ?? [""]) {
      chunks.push({ model, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
    }
    chunks.push({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  } else {
    const args = toolCall!.function.arguments;
    chunks.push({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall!.id, type: "function", function: { name: "codemode", arguments: "" } }] } }] });
    chunks.push({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 10) } }] } }] });
    chunks.push({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] } }] });
    chunks.push({ model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  }
  chunks.push({ model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function geminiResponse(reply: Extract<Reply, { kind: "text" | "tool" }>, stream: boolean): Response {
  const part =
    reply.kind === "text"
      ? { text: reply.text }
      : { functionCall: { name: "codemode", args: { code: reply.code } }, thoughtSignature: reply.thoughtSignature ?? "sig-abc123" };
  const payload = {
    candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 15, totalTokenCount: 105 },
    modelVersion: "gemini-3.6-flash"
  };
  if (!stream) return Response.json(payload);
  return new Response(`data: ${JSON.stringify(payload)}\r\n\r\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Canned provider error bodies, shaped like the real APIs.
export const groq429 = (retryAfter = "30", perDay = false): Reply => ({
  kind: "http",
  status: 429,
  headers: { "retry-after": retryAfter },
  body: {
    error: {
      message: perDay
        ? "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on tokens per day (TPD): Limit 200000, Used 199990, Requested 900. Please try again in 7m12s."
        : "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` on requests per minute (RPM): Limit 30, Used 30, Requested 1. Please try again in 30s.",
      type: "tokens",
      code: "rate_limit_exceeded"
    }
  }
});

export const groqError = (status: number, message = "Internal Server Error", code?: string): Reply => ({
  kind: "http",
  status,
  body: { error: { message, type: status === 401 ? "invalid_request_error" : "server_error", code } }
});

export const groq401: Reply = groqError(401, "Invalid API Key", "invalid_api_key");

export const geminiError = (status: number, statusText: string, message: string, details: unknown[] = []): Reply => ({
  kind: "http",
  status,
  body: { error: { code: status, message, status: statusText, details } }
});

export const gemini503 = geminiError(503, "UNAVAILABLE", "The model is overloaded. Please try again later.");
