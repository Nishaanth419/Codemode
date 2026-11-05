/**
 * Shared client for OpenAI-compatible Chat Completions APIs (Groq, Ollama).
 *
 * Uses plain fetch rather than an SDK so that we control retries (none here; the
 * router owns retry policy), can read Retry-After headers, and can inject a mock
 * fetch in tests.
 */
import {
  classifyHttpError,
  classifyThrown,
  parseDurationMs,
  parseRetryAfter,
  ProviderError,
  withTimeout
} from "./errors.js";
import type {
  ChatMessage,
  FinishReason,
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  ProviderName,
  StreamChunk,
  StructuredRequest,
  StructuredResult,
  ToolCall
} from "./provider-interface.js";
import { extractJson, newToolCallId, parseToolArguments } from "./provider-interface.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenAICompatibleOptions {
  name: ProviderName;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** Requires an API key to be considered configured. */
  requiresApiKey?: boolean;
  /** Extra provider-specific body fields, e.g. Groq `reasoning_effort`. */
  extraBody?: Record<string, unknown>;
  fetch?: FetchLike;
}

interface OpenAIToolCall {
  id?: string;
  index?: number;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly timeoutMs: number;
  protected readonly requiresApiKey: boolean;
  protected readonly extraBody: Record<string, unknown>;
  protected readonly fetchImpl: FetchLike;

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.requiresApiKey = opts.requiresApiKey ?? true;
    this.extraBody = opts.extraBody ?? {};
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  isConfigured(): boolean {
    return Boolean(this.model) && (!this.requiresApiKey || Boolean(this.apiKey));
  }

  // ---------------------------------------------------------------- requests

  protected toWireMessages(request: GenerateRequest): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    if (request.system) out.push({ role: "system", content: request.system });
    for (const m of request.messages) out.push(...this.toWireMessage(m));
    return out;
  }

  protected toWireMessage(m: ChatMessage): Record<string, unknown>[] {
    if (m.role === "user") return [{ role: "user", content: m.content }];
    if (m.role === "tool") return [{ role: "tool", tool_call_id: m.toolCallId, content: m.content }];
    const msg: Record<string, unknown> = { role: "assistant", content: m.content ?? "" };
    if (m.toolCalls?.length) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) }
      }));
    }
    return [msg];
  }

  protected buildBody(request: GenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toWireMessages(request),
      stream,
      ...this.extraBody
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_completion_tokens = request.maxOutputTokens;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
      body.tool_choice = request.toolChoice ?? "auto";
    }
    return body;
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  protected async post(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) throw await this.errorFromResponse(res);
    return res;
  }

  protected async errorFromResponse(res: Response): Promise<ProviderError> {
    const raw = await res.text().catch(() => "");
    let message = raw || res.statusText || "request failed";
    let code: string | undefined;
    let type: string | undefined;
    try {
      const parsed = JSON.parse(raw);
      const e = parsed?.error ?? parsed;
      message = typeof e === "string" ? e : (e?.message ?? message);
      code = e?.code ? String(e.code) : undefined;
      type = e?.type ? String(e.type) : undefined;
    } catch {
      /* non-JSON body */
    }
    const retryAfterMs =
      parseRetryAfter(res.headers.get("retry-after")) ??
      parseDurationMs(message.match(/try again in ([\d.hms]+)/i)?.[1]);
    return classifyHttpError({ provider: this.name, status: res.status, message, code, type, retryAfterMs, rawBody: raw });
  }

  normalizeError(error: unknown): ProviderError {
    return classifyThrown(this.name, error);
  }

  // ---------------------------------------------------------------- generate

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const t = withTimeout(this.timeoutMs, request.signal);
    try {
      const res = await this.post(this.buildBody(request, false), t.signal);
      const json = (await res.json()) as any;
      const choice = json?.choices?.[0];
      if (!choice?.message) {
        throw new ProviderError({ provider: this.name, kind: "invalid_response", message: `${this.name} returned no choices` });
      }
      return {
        text: typeof choice.message.content === "string" ? choice.message.content : "",
        toolCalls: this.parseToolCalls(choice.message.tool_calls),
        finishReason: mapFinish(choice.finish_reason),
        usage: mapUsage(json.usage ?? json.x_groq?.usage),
        provider: this.name,
        model: json.model ?? this.model,
        latencyMs: Date.now() - started
      };
    } catch (err) {
      throw classifyThrown(this.name, err, t.signal);
    } finally {
      t.dispose();
    }
  }

  protected parseToolCalls(raw: OpenAIToolCall[] | undefined): ToolCall[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((tc) => tc?.function?.name)
      .map((tc) => ({
        id: tc.id || newToolCallId(this.name),
        name: tc.function!.name!,
        arguments: parseToolArguments(tc.function!.arguments),
        providerMeta: { provider: this.name }
      }));
  }

  // ---------------------------------------------------------------- stream

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const started = Date.now();
    const t = withTimeout(this.timeoutMs, request.signal);
    try {
      const body = this.buildBody(request, true);
      body.stream_options = { include_usage: true };
      const res = await this.post(body, t.signal);
      if (!res.body) throw new ProviderError({ provider: this.name, kind: "invalid_response", message: "Empty stream body" });

      let text = "";
      let finishReason: FinishReason = "unknown";
      let usage: GenerateResult["usage"];
      let model = this.model;
      const calls = new Map<number, { id?: string; name: string; args: string }>();
      let sawDone = false;

      for await (const data of sseData(res.body)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) {
          const e = chunk.error;
          throw classifyHttpError({
            provider: this.name,
            status: Number(e.status_code ?? e.code) || 500,
            message: e.message ?? JSON.stringify(e),
            code: e.code ? String(e.code) : undefined,
            type: e.type
          });
        }
        if (chunk.model) model = chunk.model;
        const u = chunk.usage ?? chunk.x_groq?.usage;
        if (u) usage = mapUsage(u);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          yield { type: "text-delta", text: delta.content };
        }
        for (const tc of (delta.tool_calls ?? []) as OpenAIToolCall[]) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
        if (choice.finish_reason) finishReason = mapFinish(choice.finish_reason);
      }

      const toolCalls: ToolCall[] = [...calls.values()]
        .filter((c) => c.name)
        .map((c) => ({
          id: c.id || newToolCallId(this.name),
          name: c.name,
          arguments: parseToolArguments(c.args),
          providerMeta: { provider: this.name }
        }));
      if (toolCalls.length && finishReason === "unknown") finishReason = "tool_calls";
      if (!sawDone && finishReason === "unknown" && !text && !toolCalls.length) {
        // The server closed the stream without a terminator or any output (e.g. a tool call it failed to parse).
        throw new ProviderError({ provider: this.name, kind: "generation_failed", message: `${this.name} stream ended without a result` });
      }

      yield {
        type: "finish",
        result: { text, toolCalls, finishReason, usage, provider: this.name, model, latencyMs: Date.now() - started }
      };
    } catch (err) {
      throw classifyThrown(this.name, err, t.signal);
    } finally {
      t.dispose();
    }
  }

  // ---------------------------------------------------------------- structured

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const t = withTimeout(this.timeoutMs, request.signal);
    try {
      const base = this.buildBody({ ...request, tools: undefined }, false);
      let res: Response;
      try {
        res = await this.post(
          { ...base, response_format: { type: "json_schema", json_schema: { name: request.schemaName, schema: request.jsonSchema } } },
          t.signal
        );
      } catch (err) {
        // Some models only support JSON mode; retry once with json_object + schema in the prompt.
        if (!(err instanceof ProviderError) || err.kind !== "bad_request") throw err;
        const messages = this.toWireMessages({
          ...request,
          system: `${request.system}\n\nRespond with a single JSON object matching this JSON Schema:\n${JSON.stringify(request.jsonSchema)}`
        });
        res = await this.post({ ...base, messages, response_format: { type: "json_object" } }, t.signal);
      }
      const json = (await res.json()) as any;
      const text: string = json?.choices?.[0]?.message?.content ?? "";
      const parsed = request.schema.safeParse(extractJson(text));
      if (!parsed.success) {
        throw new ProviderError({
          provider: this.name,
          kind: "invalid_response",
          message: `${this.name} structured output failed validation: ${parsed.error.message}`
        });
      }
      return {
        object: parsed.data,
        result: {
          text,
          toolCalls: [],
          finishReason: mapFinish(json?.choices?.[0]?.finish_reason),
          usage: mapUsage(json?.usage),
          provider: this.name,
          model: json?.model ?? this.model,
          latencyMs: Date.now() - started
        }
      };
    } catch (err) {
      throw classifyThrown(this.name, err, t.signal);
    } finally {
      t.dispose();
    }
  }
}

function mapFinish(reason: unknown): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

function mapUsage(u: any): GenerateResult["usage"] {
  if (!u) return undefined;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, totalTokens: u.total_tokens };
}

/** Yield the `data:` payloads of a Server-Sent Events byte stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
    const rest = buffer
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}
