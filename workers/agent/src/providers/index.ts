import type { AppConfig } from "../config.js";
import { GeminiProvider } from "./gemini-provider.js";
import { GroqProvider } from "./groq-provider.js";
import { OllamaProvider } from "./ollama-provider.js";
import type { FetchLike } from "./openai-compatible.js";
import { ProviderHealthTracker, type ProviderRole } from "./provider-health.js";
import type { LLMProvider, ProviderName } from "./provider-interface.js";
import { ProviderRouter } from "./provider-router.js";
import { RetryPolicy } from "./retry-policy.js";

export * from "./errors.js";
export * from "./provider-interface.js";
export * from "./provider-health.js";
export * from "./provider-router.js";
export * from "./retry-policy.js";
export { GroqProvider } from "./groq-provider.js";
export { GeminiProvider } from "./gemini-provider.js";
export { OllamaProvider } from "./ollama-provider.js";
export type { FetchLike } from "./openai-compatible.js";

export function createProviders(config: AppConfig, fetchImpl?: FetchLike): Record<ProviderName, LLMProvider> {
  return {
    groq: new GroqProvider({
      apiKey: config.GROQ_API_KEY,
      model: config.GROQ_MODEL,
      baseUrl: config.GROQ_BASE_URL,
      timeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
      fetch: fetchImpl
    }),
    gemini: new GeminiProvider({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      timeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
      fetch: fetchImpl
    }),
    ollama: new OllamaProvider({
      enabled: config.OLLAMA_ENABLED,
      baseUrl: config.OLLAMA_BASE_URL,
      model: config.OLLAMA_MODEL,
      timeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
      fetch: fetchImpl
    })
  };
}

/**
 * Build the router from configuration. Priority: LLM_PRIMARY_PROVIDER, then
 * LLM_FALLBACK_PROVIDER, then Ollama (only when OLLAMA_ENABLED=true and not already listed).
 * Providers without credentials stay visible in the status panel as "not configured"
 * but are never called, which is what lets the app run on Groq alone, Gemini alone,
 * or both.
 */
export function createProviderRouter(
  config: AppConfig,
  opts: { fetch?: FetchLike; providers?: Record<ProviderName, LLMProvider>; health?: ProviderHealthTracker } = {}
): ProviderRouter {
  const all = opts.providers ?? createProviders(config, opts.fetch);
  const order: { name: ProviderName; role: ProviderRole }[] = [{ name: config.LLM_PRIMARY_PROVIDER, role: "primary" }];
  if (config.LLM_FALLBACK_PROVIDER && config.LLM_FALLBACK_PROVIDER !== config.LLM_PRIMARY_PROVIDER) {
    order.push({ name: config.LLM_FALLBACK_PROVIDER, role: "fallback" });
  }
  if (config.OLLAMA_ENABLED && !order.some((o) => o.name === "ollama")) {
    order.push({ name: "ollama", role: "optional" });
  }
  return new ProviderRouter({
    providers: order.map((o) => ({ provider: all[o.name], role: o.role })),
    health: opts.health ?? new ProviderHealthTracker(),
    retryPolicy: new RetryPolicy({ maxRetries: config.LLM_MAX_RETRIES, maxRetryWaitMs: config.LLM_MAX_RETRY_WAIT_MS }),
    autoFailover: config.LLM_AUTO_FAILOVER
  });
}
