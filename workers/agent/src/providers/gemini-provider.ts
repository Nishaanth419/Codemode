/**
 * Google Gemini — automatic fallback provider, via the official @google/genai SDK.
 *
 * Default model: gemini-3.6-flash (stable Flash model with function calling and
 * structured output). Override with GEMINI_MODEL.
 *
 * Continuity notes:
 *  - Gemini thinking models attach a `thoughtSignature` to function-call parts and
 *    reject replayed history if a signature is missing. Gemini-originated tool calls
 *    keep their signature in `providerMeta` and are replayed verbatim.
 *  - Tool calls produced by another provider (e.g. Groq before a failover) have no
 *    signature, so they are replayed as plain-text transcripts of the call and its
 *    result. Gemini still sees exactly what was executed and what it returned.
 *  - SDK-level retries are left disabled (the SDK default); the router owns retries.
 */
import { ApiError, FunctionCallingConfigMode, GoogleGenAI, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import { classifyHttpError, classifyThrown, parseDurationMs, ProviderError, withTimeout } from "./errors.js";
import type { FetchLike } from "./openai-compatible.js";
import type {
  ChatMessage,
  FinishReason,
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  StreamChunk,
  StructuredRequest,
  StructuredResult,
  ToolCall
} from "./provider-interface.js";
import { extractJson, newToolCallId } from "./provider-interface.js";

export const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash";

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Custom fetch passed to the SDK's httpOptions (used by tests). */
  fetch?: FetchLike;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: FetchLike;
  private client?: GoogleGenAI;

  constructor(opts: GeminiProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || GEMINI_DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.model);
  }

  private sdk(): GoogleGenAI {
    if (!this.client) {
      this.client = new GoogleGenAI({
        apiKey: this.apiKey,
        httpOptions: this.fetchImpl ? { fetch: this.fetchImpl as never } : undefined
      });
    }
    return this.client;
  }

  // ------------------------------------------------------------ conversion

  /** Convert internal history to Gemini `contents`. Exported for tests. */
  toContents(messages: ChatMessage[]): Content[] {
    const contents: Content[] = [];
    const nativeCalls = new Set<string>();
    const callNames = new Map<string, string>();

    const push = (role: "user" | "model", parts: Part[]) => {
      if (!parts.length) return;
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts = [...(last.parts ?? []), ...parts];
      else contents.push({ role, parts });
    };

    for (const m of messages) {
      if (m.role === "user") {
        push("user", [{ text: m.content }]);
      } else if (m.role === "assistant") {
        const parts: Part[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls ?? []) {
          callNames.set(tc.id, tc.name);
          if (tc.providerMeta?.provider === "gemini") {
            nativeCalls.add(tc.id);
            const part: Part = { functionCall: { name: tc.name, args: tc.arguments } };
            if (tc.providerMeta.thoughtSignature) part.thoughtSignature = tc.providerMeta.thoughtSignature;
            parts.push(part);
          } else {
            const by = m.provider ? ` by ${m.provider}${m.model ? `/${m.model}` : ""}` : "";
            parts.push({
              text: `[Earlier tool call ${tc.id}${by}] ${tc.name}(${JSON.stringify(tc.arguments)})`
            });
          }
        }
        push("model", parts.length ? parts : [{ text: "" }]);
      } else {
        if (nativeCalls.has(m.toolCallId)) {
          push("user", [
            { functionResponse: { name: callNames.get(m.toolCallId) ?? m.toolName, response: toResponseObject(m.content) } }
          ]);
        } else {
          push("user", [{ text: `[Result of tool call ${m.toolCallId} (${m.toolName}) — already executed, do not re-run]\n${m.content}` }]);
        }
      }
    }
    return contents;
  }

  private buildParams(request: GenerateRequest, signal: AbortSignal, extra: Record<string, unknown> = {}) {
    const config: Record<string, unknown> = {
      systemInstruction: request.system || undefined,
      abortSignal: signal,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      ...extra
    };
    if (request.tools?.length) {
      config.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parameters
          }))
        }
      ];
      config.toolConfig = {
        functionCallingConfig: {
          mode:
            request.toolChoice === "none"
              ? FunctionCallingConfigMode.NONE
              : request.toolChoice === "required"
                ? FunctionCallingConfigMode.ANY
                : FunctionCallingConfigMode.AUTO
        }
      };
    }
    return { model: this.model, contents: this.toContents(request.messages), config };
  }

  private parseResponse(resp: GenerateContentResponse, started: number): GenerateResult {
    const candidate = resp.candidates?.[0];
    if (!candidate) {
      const blocked = resp.promptFeedback?.blockReason;
      throw new ProviderError({
        provider: "gemini",
        kind: blocked ? "bad_request" : "invalid_response",
        message: blocked ? `Gemini blocked the prompt: ${blocked}` : "Gemini returned no candidates"
      });
    }
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall?.name) {
        toolCalls.push({
          id: part.functionCall.id || newToolCallId("gemini"),
          name: part.functionCall.name,
          arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
          providerMeta: { provider: "gemini", thoughtSignature: part.thoughtSignature }
        });
      } else if (typeof part.text === "string" && !part.thought) {
        text += part.text;
      }
    }
    if (!toolCalls.length && !text && candidate.finishReason === "MALFORMED_FUNCTION_CALL") {
      throw new ProviderError({ provider: "gemini", kind: "generation_failed", message: "Gemini produced a malformed function call" });
    }
    return {
      text,
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : mapFinish(candidate.finishReason),
      usage: resp.usageMetadata
        ? {
            inputTokens: resp.usageMetadata.promptTokenCount,
            outputTokens: resp.usageMetadata.candidatesTokenCount,
            totalTokens: resp.usageMetadata.totalTokenCount
          }
        : undefined,
      provider: "gemini",
      model: resp.modelVersion || this.model,
      latencyMs: Date.now() - started
    };
  }

  // ------------------------------------------------------------ errors

  normalizeError(error: unknown, signal?: AbortSignal): ProviderError {
    if (error instanceof ProviderError) return error;
    if (error instanceof ApiError || (typeof (error as ApiError)?.status === "number" && (error as Error)?.name === "ApiError")) {
      const apiErr = error as ApiError;
      let message = apiErr.message;
      let code: string | undefined;
      let retryAfterMs: number | undefined;
      let quotaIds = "";
      try {
        const body = JSON.parse(apiErr.message);
        const e = body?.error ?? body;
        message = e?.message ?? message;
        code = e?.status;
        for (const d of e?.details ?? []) {
          if (String(d?.["@type"]).endsWith("RetryInfo")) retryAfterMs = parseDurationMs(d.retryDelay);
          if (String(d?.["@type"]).endsWith("QuotaFailure")) {
            quotaIds += (d.violations ?? []).map((v: any) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`).join(" ");
          }
          if (String(d?.["@type"]).endsWith("ErrorInfo") && d.reason) code = `${code ?? ""} ${d.reason}`.trim();
        }
      } catch {
        /* message was not JSON */
      }
      return classifyHttpError({
        provider: "gemini",
        status: apiErr.status,
        message,
        code,
        retryAfterMs,
        // Only quota ids feed daily-quota detection, so a docs link in the message cannot trigger it.
        rawBody: quotaIds
      });
    }
    return classifyThrown("gemini", error, signal);
  }

  // ------------------------------------------------------------ calls

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const t = withTimeout(this.timeoutMs, request.signal);
    try {
      const resp = await this.sdk().models.generateContent(this.buildParams(request, t.signal));
      return this.parseResponse(resp, started);
    } catch (err) {
      throw this.normalizeError(err, t.signal);
    } finally {
      t.dispose();
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const started = Date.now();
    const t = withTimeout(this.timeoutMs, request.signal);
    try {
      const iterator = await this.sdk().models.generateContentStream(this.buildParams(request, t.signal));
      let text = "";
      const toolCalls: ToolCall[] = [];
      let finish: FinishReason = "unknown";
      let usage: GenerateResult["usage"];
      let model = this.model;
      for await (const chunk of iterator) {
        if (chunk.modelVersion) model = chunk.modelVersion;
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount,
            outputTokens: chunk.usageMetadata.candidatesTokenCount,
            totalTokens: chunk.usageMetadata.totalTokenCount
          };
        }
        const cand = chunk.candidates?.[0];
        if (cand?.finishReason) finish = mapFinish(cand.finishReason);
        for (const part of cand?.content?.parts ?? []) {
          if (part.functionCall?.name) {
            toolCalls.push({
              id: part.functionCall.id || newToolCallId("gemini"),
              name: part.functionCall.name,
              arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
              providerMeta: { provider: "gemini", thoughtSignature: part.thoughtSignature }
            });
          } else if (typeof part.text === "string" && part.text && !part.thought) {
            text += part.text;
            yield { type: "text-delta", text: part.text };
          }
        }
      }
      yield {
        type: "finish",
        result: {
          text,
          toolCalls,
          finishReason: toolCalls.length ? "tool_calls" : finish,
          usage,
          provider: "gemini",
          model,
          latencyMs: Date.now() - started
        }
      };
    } catch (err) {
      throw this.normalizeError(err, t.signal);
    } finally {
      t.dispose();
    }
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const t = withTimeout(this.timeoutMs, request.signal);
    try {
      const resp = await this.sdk().models.generateContent(
        this.buildParams({ ...request, tools: undefined }, t.signal, {
          responseMimeType: "application/json",
          responseJsonSchema: request.jsonSchema
        })
      );
      const result = this.parseResponse(resp, started);
      const parsed = request.schema.safeParse(extractJson(result.text));
      if (!parsed.success) {
        throw new ProviderError({
          provider: "gemini",
          kind: "invalid_response",
          message: `Gemini structured output failed validation: ${parsed.error.message}`
        });
      }
      return { object: parsed.data, result };
    } catch (err) {
      throw this.normalizeError(err, t.signal);
    } finally {
      t.dispose();
    }
  }
}

function toResponseObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: parsed };
  } catch {
    return { output: content };
  }
}

function mapFinish(reason: unknown): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "error";
    default:
      return "unknown";
  }
}
