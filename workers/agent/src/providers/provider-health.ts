/**
 * In-memory provider health tracking.
 *
 * Tracks, per provider: availability, last success, last error, consecutive failures,
 * rate-limit status, retry-after timestamp and request counts. Remaining quota is
 * deliberately NOT tracked: neither Groq nor Gemini exposes a reliable remaining
 * daily quota for free-tier keys, so the UI shows "not reported" instead of guessing.
 */
import { EventEmitter } from "node:events";
import type { ProviderError, ProviderErrorKind } from "./errors.js";
import { PROVIDER_LABELS, type ProviderName } from "./provider-interface.js";

export type ProviderStatus = "active" | "standby" | "rate_limited" | "unavailable" | "unconfigured";
export type ProviderRole = "primary" | "fallback" | "optional";

export interface ProviderHealthSnapshot {
  name: ProviderName;
  label: string;
  model: string;
  role: ProviderRole;
  configured: boolean;
  status: ProviderStatus;
  available: boolean;
  lastSuccessAt: string | null;
  lastError: { kind: ProviderErrorKind; message: string; summary: string; status?: number; at: string } | null;
  consecutiveFailures: number;
  rateLimited: boolean;
  retryAfter: string | null;
  requestsMade: number;
  successes: number;
  failures: number;
  /** Always null: providers do not expose remaining free-tier quota. */
  quotaRemaining: null;
}

export interface HealthSummary {
  currentProvider: ProviderName | null;
  autoFailover: boolean;
  providers: ProviderHealthSnapshot[];
  updatedAt: string;
}

interface State {
  name: ProviderName;
  model: string;
  role: ProviderRole;
  configured: boolean;
  lastSuccessAt: number | null;
  lastError: ProviderHealthSnapshot["lastError"];
  consecutiveFailures: number;
  rateLimitedUntil: number | null;
  unavailableUntil: number | null;
  configError: boolean;
  requestsMade: number;
  successes: number;
  failures: number;
}

export interface HealthOptions {
  /** Consecutive transient failures that open the circuit. */
  circuitThreshold: number;
  circuitCooldownMs: number;
  /** Used when a 429 carries no Retry-After. */
  defaultRateLimitMs: number;
  /** Used when a daily quota error carries no Retry-After. */
  defaultQuotaMs: number;
  now: () => number;
}

const DEFAULTS: HealthOptions = {
  circuitThreshold: 3,
  circuitCooldownMs: 30_000,
  defaultRateLimitMs: 30_000,
  defaultQuotaMs: 15 * 60_000,
  now: () => Date.now()
};

export class ProviderHealthTracker extends EventEmitter {
  private readonly states = new Map<ProviderName, State>();
  private readonly order: ProviderName[] = [];
  private readonly opts: HealthOptions;
  autoFailover = true;

  constructor(opts: Partial<HealthOptions> = {}) {
    super();
    this.opts = { ...DEFAULTS, ...opts };
  }

  register(name: ProviderName, info: { model: string; role: ProviderRole; configured: boolean }) {
    if (!this.states.has(name)) this.order.push(name);
    this.states.set(name, {
      name,
      model: info.model,
      role: info.role,
      configured: info.configured,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      rateLimitedUntil: null,
      unavailableUntil: null,
      configError: false,
      requestsMade: 0,
      successes: 0,
      failures: 0
    });
    this.changed();
  }

  private get(name: ProviderName): State {
    const s = this.states.get(name);
    if (!s) throw new Error(`Unknown provider ${name}`);
    return s;
  }

  recordRequest(name: ProviderName) {
    this.get(name).requestsMade++;
    this.changed();
  }

  recordSuccess(name: ProviderName) {
    const s = this.get(name);
    s.successes++;
    s.lastSuccessAt = this.opts.now();
    s.consecutiveFailures = 0;
    s.rateLimitedUntil = null;
    s.unavailableUntil = null;
    s.configError = false;
    this.changed();
  }

  recordFailure(name: ProviderName, error: ProviderError) {
    const s = this.get(name);
    const now = this.opts.now();
    if (error.kind === "aborted") return;
    s.failures++;
    s.consecutiveFailures++;
    s.lastError = {
      kind: error.kind,
      message: error.message,
      summary: error.summary,
      status: error.status,
      at: new Date(now).toISOString()
    };
    if (error.kind === "rate_limit") {
      s.rateLimitedUntil = now + (error.retryAfterMs ?? this.opts.defaultRateLimitMs);
    } else if (error.kind === "quota_exhausted") {
      s.rateLimitedUntil = now + (error.retryAfterMs ?? this.opts.defaultQuotaMs);
    } else if (error.permanent) {
      s.configError = true;
    } else if (s.consecutiveFailures >= this.opts.circuitThreshold) {
      s.unavailableUntil = now + this.opts.circuitCooldownMs;
    }
    this.changed();
  }

  /** Whether the router should send traffic to this provider right now. */
  isAvailable(name: ProviderName): boolean {
    const s = this.get(name);
    const now = this.opts.now();
    if (!s.configured) return false;
    if (s.rateLimitedUntil && s.rateLimitedUntil > now) return false;
    if (s.unavailableUntil && s.unavailableUntil > now) return false;
    return true;
  }

  /** Why a provider is being skipped, for execution events. */
  skipReason(name: ProviderName): { reason: string; retryAt: string | null } {
    const s = this.get(name);
    const now = this.opts.now();
    const label = PROVIDER_LABELS[name];
    if (!s.configured) return { reason: `${label} is not configured`, retryAt: null };
    if (s.rateLimitedUntil && s.rateLimitedUntil > now) {
      return {
        reason: s.lastError?.kind === "quota_exhausted" ? `${label} daily quota exhausted` : `${label} rate limit reached`,
        retryAt: new Date(s.rateLimitedUntil).toISOString()
      };
    }
    if (s.unavailableUntil && s.unavailableUntil > now) {
      return { reason: `${label} is unavailable after repeated failures`, retryAt: new Date(s.unavailableUntil).toISOString() };
    }
    return { reason: `${label} is available`, retryAt: null };
  }

  /** The provider the next request will go to: first available one in priority order. */
  currentProvider(): ProviderName | null {
    for (const name of this.order) if (this.isAvailable(name)) return name;
    return null;
  }

  snapshot(): HealthSummary {
    const now = this.opts.now();
    const current = this.currentProvider();
    const providers = this.order.map((name): ProviderHealthSnapshot => {
      const s = this.get(name);
      const rateLimited = Boolean(s.rateLimitedUntil && s.rateLimitedUntil > now);
      const circuitOpen = Boolean(s.unavailableUntil && s.unavailableUntil > now);
      let status: ProviderStatus;
      if (!s.configured) status = "unconfigured";
      else if (rateLimited) status = "rate_limited";
      else if (circuitOpen || s.configError) status = "unavailable";
      else if (current === name) status = "active";
      else status = "standby";
      const until = rateLimited ? s.rateLimitedUntil : circuitOpen ? s.unavailableUntil : null;
      return {
        name,
        label: PROVIDER_LABELS[name],
        model: s.model,
        role: s.role,
        configured: s.configured,
        status,
        available: this.isAvailable(name),
        lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
        lastError: s.lastError,
        consecutiveFailures: s.consecutiveFailures,
        rateLimited,
        retryAfter: until ? new Date(until).toISOString() : null,
        requestsMade: s.requestsMade,
        successes: s.successes,
        failures: s.failures,
        quotaRemaining: null
      };
    });
    return { currentProvider: current, autoFailover: this.autoFailover, providers, updatedAt: new Date(now).toISOString() };
  }

  private changed() {
    this.emit("change");
  }
}
