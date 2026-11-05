/**
 * Provider router: priority-ordered failover across LLM providers.
 *
 * For each request it walks the chain (default: Groq → Gemini):
 *   1. skip providers the health tracker marks rate-limited / circuit-open,
 *   2. call the provider; on failure classify the error,
 *   3. retry the same provider for transient errors (bounded, honouring Retry-After),
 *   4. fail over to the next provider when this one is unavailable,
 *   5. never fail over on permanent configuration errors (bad key, bad request, bad model),
 *   6. throw LLMUnavailableError when every provider is unavailable.
 *
 * The exact same GenerateRequest (system prompt, history, tool definitions) is sent to
 * every provider, so a switch preserves the full agent context. The router only ever
 * talks to the model; it never executes tools, so a failover cannot re-run code.
 */
import { ProviderError } from "./errors.js";
import type { ProviderHealthTracker, ProviderRole } from "./provider-health.js";
import {
  PROVIDER_LABELS,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type ProviderName,
  type StructuredRequest,
  type StructuredResult
} from "./provider-interface.js";
import { formatMs, RetryPolicy, sleep } from "./retry-policy.js";

export type RouterEvent =
  | { type: "provider.request"; provider: ProviderName; model: string; attempt: number }
  | { type: "provider.retry"; provider: ProviderName; attempt: number; delayMs: number; reason: string; error: ReturnType<ProviderError["toJSON"]> }
  | {
      type: "provider.failover";
      from: ProviderName;
      to: ProviderName;
      reason: string;
      message: string;
      error?: ReturnType<ProviderError["toJSON"]>;
      retryAt?: string | null;
    }
  | { type: "provider.error"; provider: ProviderName; error: ReturnType<ProviderError["toJSON"]>; willFailover: boolean }
  | { type: "provider.response"; provider: ProviderName; model: string; latencyMs: number; usage?: GenerateResult["usage"] }
  | { type: "provider.stream_reset"; provider: ProviderName; reason: string };

export interface RouterCallContext {
  onEvent?: (event: RouterEvent) => void;
  signal?: AbortSignal;
}

export interface StreamCallContext extends RouterCallContext {
  onTextDelta?: (text: string, provider: ProviderName) => void;
  /** Called when a provider failed after streaming partial text; the UI should discard it. */
  onReset?: (provider: ProviderName, reason: string) => void;
}

/** Every configured provider is unavailable (or none is configured). */
export class LLMUnavailableError extends Error {
  readonly code = "LLM_UNAVAILABLE";
  readonly attempts: ProviderError[];
  readonly retryAt: string | null;

  constructor(message: string, attempts: ProviderError[], retryAt: string | null) {
    super(message);
    this.name = "LLMUnavailableError";
    this.attempts = attempts;
    this.retryAt = retryAt;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryAt: this.retryAt, attempts: this.attempts.map((a) => a.toJSON()) };
  }
}

export interface ProviderRouterOptions {
  /** Providers in priority order. Unconfigured ones are kept for status display but never called. */
  providers: { provider: LLMProvider; role: ProviderRole }[];
  health: ProviderHealthTracker;
  retryPolicy?: RetryPolicy;
  autoFailover?: boolean;
}

export class ProviderRouter {
  private readonly entries: { provider: LLMProvider; role: ProviderRole }[];
  readonly health: ProviderHealthTracker;
  private readonly retry: RetryPolicy;
  readonly autoFailover: boolean;

  constructor(opts: ProviderRouterOptions) {
    this.entries = opts.providers;
    this.health = opts.health;
    this.retry = opts.retryPolicy ?? new RetryPolicy();
    this.autoFailover = opts.autoFailover ?? true;
    this.health.autoFailover = this.autoFailover;
    for (const { provider, role } of this.entries) {
      this.health.register(provider.name, { model: provider.model, role, configured: provider.isConfigured() });
    }
  }

  /** Configured providers in priority order. */
  chain(): LLMProvider[] {
    return this.entries.filter((e) => e.provider.isConfigured()).map((e) => e.provider);
  }

  getProvider(name: ProviderName): LLMProvider | undefined {
    return this.entries.find((e) => e.provider.name === name)?.provider;
  }

  generate(request: GenerateRequest, ctx: RouterCallContext = {}): Promise<GenerateResult> {
    return this.run(ctx, (p) => p.generate({ ...request, signal: ctx.signal ?? request.signal }), (r) => r);
  }

  generateStructured<T>(request: StructuredRequest<T>, ctx: RouterCallContext = {}): Promise<StructuredResult<T>> {
    return this.run(ctx, (p) => p.generateStructured({ ...request, signal: ctx.signal ?? request.signal }), (r) => r.result);
  }

  /**
   * Streaming generation with failover. Text deltas are forwarded as they arrive; if a
   * provider fails mid-stream, `onReset` tells the caller to discard the partial text
   * and the next attempt starts from the same request. Tool calls are only returned
   * in the final result, never from a partial stream.
   */
  stream(request: GenerateRequest, ctx: StreamCallContext = {}): Promise<GenerateResult> {
    return this.run(
      ctx,
      async (p) => {
        let emitted = false;
        try {
          for await (const chunk of p.stream({ ...request, signal: ctx.signal ?? request.signal })) {
            if (chunk.type === "text-delta") {
              emitted = true;
              ctx.onTextDelta?.(chunk.text, p.name);
            } else {
              return chunk.result;
            }
          }
          throw new ProviderError({ provider: p.name, kind: "invalid_response", message: `${PROVIDER_LABELS[p.name]} stream ended without a result` });
        } catch (err) {
          if (emitted) {
            const reason = err instanceof ProviderError ? err.summary : String(err);
            ctx.onReset?.(p.name, reason);
            ctx.onEvent?.({ type: "provider.stream_reset", provider: p.name, reason });
          }
          throw err;
        }
      },
      (r) => r
    );
  }

  private async run<R>(
    ctx: RouterCallContext,
    call: (provider: LLMProvider) => Promise<R>,
    toResult: (r: R) => GenerateResult
  ): Promise<R> {
    const chain = this.chain();
    if (chain.length === 0) {
      throw new LLMUnavailableError(
        "No LLM provider is configured. Set GROQ_API_KEY and/or GEMINI_API_KEY (or enable Ollama) on the server.",
        [],
        null
      );
    }

    const attempts: ProviderError[] = [];
    let pendingFailover: { from: ProviderName; reason: string; error?: ProviderError; retryAt?: string | null } | null = null;

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      if (i > 0 && !this.autoFailover) break;

      if (!this.health.isAvailable(provider.name)) {
        const skip = this.health.skipReason(provider.name);
        if (!pendingFailover) pendingFailover = { from: provider.name, reason: skip.reason, retryAt: skip.retryAt };
        attempts.push(
          new ProviderError({
            provider: provider.name,
            kind: skip.reason.includes("quota") ? "quota_exhausted" : skip.reason.includes("rate") ? "rate_limit" : "server_error",
            message: skip.retryAt ? `${skip.reason} (retry after ${skip.retryAt})` : skip.reason
          })
        );
        continue;
      }

      if (pendingFailover) {
        const message = `${pendingFailover.reason}. Switching to ${PROVIDER_LABELS[provider.name]}.`;
        ctx.onEvent?.({
          type: "provider.failover",
          from: pendingFailover.from,
          to: provider.name,
          reason: pendingFailover.reason,
          message,
          error: pendingFailover.error?.toJSON(),
          retryAt: pendingFailover.retryAt ?? null
        });
        pendingFailover = null;
      }

      let retries = 0;
      while (true) {
        this.health.recordRequest(provider.name);
        ctx.onEvent?.({ type: "provider.request", provider: provider.name, model: provider.model, attempt: retries + 1 });
        try {
          const out = await call(provider);
          const result = toResult(out);
          this.health.recordSuccess(provider.name);
          ctx.onEvent?.({
            type: "provider.response",
            provider: provider.name,
            model: result.model,
            latencyMs: result.latencyMs,
            usage: result.usage
          });
          return out;
        } catch (thrown) {
          const error = thrown instanceof ProviderError ? thrown : provider.normalizeError(thrown);
          this.health.recordFailure(provider.name, error);
          const decision = this.retry.decide(error, retries);

          if (decision.action === "retry") {
            ctx.onEvent?.({
              type: "provider.retry",
              provider: provider.name,
              attempt: retries + 1,
              delayMs: decision.delayMs,
              reason: decision.reason,
              error: error.toJSON()
            });
            await sleep(decision.delayMs, ctx.signal);
            retries++;
            continue;
          }

          const hasNext = this.autoFailover && chain.slice(i + 1).some((p) => this.health.isAvailable(p.name));
          ctx.onEvent?.({
            type: "provider.error",
            provider: provider.name,
            error: error.toJSON(),
            willFailover: decision.action === "failover" && hasNext
          });

          if (decision.action === "fail") {
            // Permanent / configuration error: surface it instead of silently using another provider.
            throw error;
          }
          attempts.push(error);
          pendingFailover = { from: provider.name, reason: decision.reason, error };
          break;
        }
      }
    }

    throw this.unavailable(attempts);
  }

  private unavailable(attempts: ProviderError[]): LLMUnavailableError {
    const retryTimes = this.chain()
      .map((p) => this.health.skipReason(p.name).retryAt)
      .filter((t): t is string => Boolean(t))
      .sort();
    const retryAt = retryTimes[0] ?? null;
    const detail = attempts.map((a) => `${PROVIDER_LABELS[a.provider]}: ${a.summary}`).join("; ");
    const configured = this.chain().map((p) => PROVIDER_LABELS[p.name]);
    const noFallback = configured.length === 1 ? ` No fallback provider is configured (only ${configured[0]}).` : "";
    const failoverOff = !this.autoFailover && configured.length > 1 ? " Automatic failover is disabled (LLM_AUTO_FAILOVER=false)." : "";
    const when = retryAt ? ` Try again after ${new Date(retryAt).toLocaleTimeString()} (${formatMs(Math.max(0, Date.parse(retryAt) - Date.now()))}).` : " Try again shortly.";
    return new LLMUnavailableError(
      `All LLM providers are unavailable. ${detail || "No provider could be reached"}.${noFallback}${failoverOff}${when}`,
      attempts,
      retryAt
    );
  }
}
