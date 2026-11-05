/**
 * Bounded retry policy. Decides, from a classified ProviderError, whether to retry
 * the same provider, fail over to the next one, or fail the request outright.
 */
import type { ProviderError } from "./errors.js";

export interface RetryPolicyOptions {
  /** Retries on the same provider for transient errors (not counting the first attempt). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Longest Retry-After we are willing to wait on the same provider. A longer wait
   * means the provider is effectively unavailable, so we fail over instead.
   */
  maxRetryWaitMs: number;
  /** 0..1 random jitter applied to backoff delays. */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicyOptions = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
  maxRetryWaitMs: 8_000,
  jitter: 0.2
};

export type RetryDecision =
  | { action: "retry"; delayMs: number; reason: string }
  | { action: "failover"; reason: string }
  | { action: "fail"; reason: string };

export class RetryPolicy {
  readonly options: RetryPolicyOptions;
  private readonly random: () => number;

  constructor(options: Partial<RetryPolicyOptions> = {}, random: () => number = Math.random) {
    this.options = { ...DEFAULT_RETRY_POLICY, ...options };
    this.random = random;
  }

  /**
   * @param error   classified failure
   * @param retries number of retries already performed on this provider for this request
   */
  decide(error: ProviderError, retries: number): RetryDecision {
    const { maxRetries, maxRetryWaitMs } = this.options;

    if (error.kind === "aborted") return { action: "fail", reason: "Request was cancelled" };
    if (error.permanent || error.kind === "unknown") {
      return { action: "fail", reason: `${error.summary}; this is not a temporary outage, so no fallback is attempted` };
    }
    if (error.kind === "quota_exhausted") {
      return { action: "failover", reason: error.summary };
    }
    if (error.kind === "rate_limit") {
      if (error.retryAfterMs !== undefined && error.retryAfterMs <= maxRetryWaitMs && retries < maxRetries) {
        return { action: "retry", delayMs: error.retryAfterMs, reason: `${error.summary}; waiting ${formatMs(error.retryAfterMs)} as requested` };
      }
      return { action: "failover", reason: error.summary };
    }
    if (error.transient) {
      if (retries < maxRetries) {
        const requested = error.retryAfterMs;
        const delayMs =
          requested !== undefined && requested <= maxRetryWaitMs ? requested : this.backoff(retries);
        return { action: "retry", delayMs, reason: `${error.summary}; retry ${retries + 1}/${maxRetries}` };
      }
      return { action: "failover", reason: `${error.summary} after ${retries + 1} attempt${retries ? "s" : ""}` };
    }
    return { action: "fail", reason: error.summary };
  }

  backoff(retries: number): number {
    const { baseDelayMs, maxDelayMs, jitter } = this.options;
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** retries);
    const spread = exp * jitter;
    return Math.max(0, Math.round(exp - spread + this.random() * spread * 2));
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
