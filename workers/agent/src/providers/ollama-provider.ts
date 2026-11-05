/**
 * Ollama — optional local provider, via Ollama's OpenAI-compatible endpoint
 * (http://127.0.0.1:11434/v1). No API key; enabled with OLLAMA_ENABLED=true.
 *
 * Recovery for a known local-model quirk: gpt-oss models served by Ollama sometimes
 * emit the tool input as raw code instead of JSON arguments, and Ollama answers with
 * HTTP 500 "error parsing tool call: raw='…'". When the request offers exactly one tool
 * whose only required parameter is `code` (the Code Mode tool), that raw text can only
 * mean `{ code: raw }`, so it is recovered as a normal tool call. Anything else stays a
 * `generation_failed` error, which the router retries.
 */
import { ProviderError } from "./errors.js";
import { OpenAICompatibleProvider, type FetchLike } from "./openai-compatible.js";
import type { GenerateRequest, GenerateResult, StreamChunk } from "./provider-interface.js";
import { newToolCallId } from "./provider-interface.js";

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  enabled?: boolean;
  fetch?: FetchLike;
}

export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly enabled: boolean;

  constructor(opts: OllamaProviderOptions) {
    super({
      name: "ollama",
      baseUrl: opts.baseUrl || "http://127.0.0.1:11434/v1",
      model: opts.model || "gpt-oss:20b",
      // Local models are slower; give them more room than hosted providers.
      timeoutMs: Math.max(opts.timeoutMs ?? 0, 180_000),
      requiresApiKey: false,
      fetch: opts.fetch
    });
    this.enabled = opts.enabled ?? false;
  }

  override isConfigured(): boolean {
    return this.enabled && super.isConfigured();
  }

  override async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    try {
      return await super.generate(request);
    } catch (err) {
      const recovered = this.recover(err, request, started);
      if (recovered) return recovered;
      throw err;
    }
  }

  override async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const started = Date.now();
    let emitted = false;
    try {
      for await (const chunk of super.stream(request)) {
        if (chunk.type === "text-delta") emitted = true;
        yield chunk;
      }
    } catch (err) {
      const recovered = this.recover(err, request, started);
      if (recovered) {
        yield { type: "finish", result: recovered };
        return;
      }
      // In streaming mode Ollama silently drops a tool call it cannot parse. Ask again
      // without streaming, where the raw call comes back in the error and can be recovered.
      if (!emitted && err instanceof ProviderError && err.kind === "generation_failed") {
        yield { type: "finish", result: await this.generate(request) };
        return;
      }
      throw err;
    }
  }

  private recover(err: unknown, request: GenerateRequest, started: number): GenerateResult | undefined {
    if (!(err instanceof ProviderError) || err.kind !== "generation_failed" || !err.details) return undefined;
    const tool = request.tools?.length === 1 ? request.tools[0] : undefined;
    const required = (tool?.parameters.required as string[] | undefined) ?? [];
    if (!tool || required.length !== 1 || required[0] !== "code") return undefined;
    let message = err.details;
    try {
      message = JSON.parse(err.details)?.error?.message ?? err.details;
    } catch {
      /* raw text */
    }
    const m = message.match(/error parsing tool call: raw='([\s\S]*)', err=/);
    if (!m || !m[1].trim()) return undefined;
    return {
      text: "",
      toolCalls: [{ id: newToolCallId("ollama"), name: tool.name, arguments: { code: m[1] }, providerMeta: { provider: "ollama" } }],
      finishReason: "tool_calls",
      provider: "ollama",
      model: this.model,
      latencyMs: Date.now() - started
    };
  }
}
