/**
 * Groq — primary provider, via Groq's OpenAI-compatible API.
 * https://api.groq.com/openai/v1  (default model: openai/gpt-oss-120b)
 *
 * Groq returns `retry-after` on 429s, and the message says whether the limit is per
 * minute or per day ("tokens per day (TPD)"), which errors.ts uses to tell a short
 * rate limit from an exhausted daily quota. Groq does not expose a remaining daily
 * quota for the free tier, so AgentOS never shows one.
 */
import { OpenAICompatibleProvider, type FetchLike } from "./openai-compatible.js";

export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";

export interface GroqProviderOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

export class GroqProvider extends OpenAICompatibleProvider {
  constructor(opts: GroqProviderOptions) {
    const model = opts.model || GROQ_DEFAULT_MODEL;
    super({
      name: "groq",
      baseUrl: opts.baseUrl || GROQ_DEFAULT_BASE_URL,
      apiKey: opts.apiKey,
      model,
      timeoutMs: opts.timeoutMs,
      requiresApiKey: true,
      // gpt-oss models are reasoning models; medium effort keeps latency and token use reasonable.
      extraBody: model.startsWith("openai/gpt-oss") ? { reasoning_effort: "medium" } : {},
      fetch: opts.fetch
    });
  }
}
