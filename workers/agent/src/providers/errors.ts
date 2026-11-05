/**
 * Normalized provider errors.
 *
 * Every provider failure becomes a ProviderError with a `kind`. The retry policy and
 * the router decide what to do purely from that classification:
 *
 *   kind               retry same provider?          fail over?
 *   rate_limit         if Retry-After is short       yes
 *   quota_exhausted    no (daily quota)              yes
 *   server_error       yes (bounded)                 yes
 *   timeout / network  yes (bounded)                 yes
 *   generation_failed  yes (bounded)                 yes   (e.g. Groq `tool_use_failed`)
 *   empty_response     yes (bounded)                 yes   (no text and no tool call)
 *   invalid_response   yes (bounded)                 yes
 *   auth               no                            NO  (invalid key = configuration error)
 *   bad_request        no                            NO  (malformed request)
 *   model_not_found    no                            NO  (unsupported / decommissioned model)
 *   context_length     no                            NO
 *   aborted            no                            NO  (cancelled by the user)
 *   unknown            no                            NO
 */
import type { ProviderName } from "./provider-interface.js";
import { PROVIDER_LABELS } from "./provider-interface.js";

export type ProviderErrorKind =
  | "rate_limit"
  | "quota_exhausted"
  | "server_error"
  | "timeout"
  | "network"
  | "generation_failed"
  | "empty_response"
  | "invalid_response"
  | "auth"
  | "bad_request"
  | "model_not_found"
  | "context_length"
  | "aborted"
  | "unknown";

const TRANSIENT: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limit",
  "server_error",
  "timeout",
  "network",
  "generation_failed",
  "empty_response",
  "invalid_response"
]);

const FAILOVER: ReadonlySet<ProviderErrorKind> = new Set([...TRANSIENT, "quota_exhausted"]);

export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly code?: string;
  /** Milliseconds the provider asked us to wait, when it said so. */
  readonly retryAfterMs?: number;
  /** Raw provider response body (truncated), for provider-specific recovery and debugging. */
  readonly details?: string;

  constructor(opts: {
    provider: ProviderName;
    kind: ProviderErrorKind;
    message: string;
    status?: number;
    code?: string;
    retryAfterMs?: number;
    details?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.kind = opts.kind;
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }

  /** Worth retrying on the same provider (subject to the retry policy's limits). */
  get transient(): boolean {
    return TRANSIENT.has(this.kind);
  }

  /** The provider is temporarily unusable, so another provider may take over. */
  get fallbackEligible(): boolean {
    return FAILOVER.has(this.kind);
  }

  /** Configuration problems the operator must fix; never hidden behind a fallback. */
  get permanent(): boolean {
    return ["auth", "bad_request", "model_not_found", "context_length"].includes(this.kind);
  }

  /** Short human sentence used in execution events and UI. */
  get summary(): string {
    const label = PROVIDER_LABELS[this.provider];
    switch (this.kind) {
      case "rate_limit":
        return `${label} rate limit reached`;
      case "quota_exhausted":
        return `${label} daily quota exhausted`;
      case "server_error":
        return `${label} server error${this.status ? ` (HTTP ${this.status})` : ""}`;
      case "timeout":
        return `${label} request timed out`;
      case "network":
        return `${label} is unreachable`;
      case "generation_failed":
        return `${label} produced an invalid tool call`;
      case "empty_response":
        return `${label} returned an empty response`;
      case "invalid_response":
        return `${label} returned an invalid response`;
      case "auth":
        return `${label} rejected the API key`;
      case "bad_request":
        return `${label} rejected the request`;
      case "model_not_found":
        return `${label} model is unavailable or unsupported`;
      case "context_length":
        return `${label} context window exceeded`;
      case "aborted":
        return `${label} request cancelled`;
      default:
        return `${label} request failed`;
    }
  }

  toJSON() {
    return {
      provider: this.provider,
      kind: this.kind,
      status: this.status,
      code: this.code,
      retryAfterMs: this.retryAfterMs,
      message: this.message,
      summary: this.summary
    };
  }
}

/** Parse durations like "37s", "7m12.5s", "1h2m3s", "250ms", "2.5". Returns milliseconds. */
export function parseDurationMs(input: string | null | undefined): number | undefined {
  if (!input) return undefined;
  const s = input.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number.parseFloat(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(re)) {
    matched = true;
    const n = Number.parseFloat(m[1]);
    const unit = m[2];
    total += unit === "h" ? n * 3_600_000 : unit === "m" ? n * 60_000 : unit === "s" ? n * 1000 : n;
  }
  return matched ? Math.round(total) : undefined;
}

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date). */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number.parseFloat(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return parseDurationMs(trimmed);
}

const DAILY_QUOTA = /per[\s_-]?day|\(TPD\)|\(RPD\)|daily|PerDay/i;

export interface HttpErrorInfo {
  provider: ProviderName;
  status: number;
  message: string;
  code?: string;
  type?: string;
  retryAfterMs?: number;
  rawBody?: string;
}

/** Classify an HTTP error response into a ProviderError. Shared by all providers. */
export function classifyHttpError(info: HttpErrorInfo): ProviderError {
  const { provider, status, code, retryAfterMs } = info;
  const text = `${info.message} ${code ?? ""} ${info.type ?? ""} ${info.rawBody ?? ""}`;
  let kind: ProviderErrorKind;

  if (status === 429) {
    kind = DAILY_QUOTA.test(text) ? "quota_exhausted" : "rate_limit";
  } else if (status === 401 || status === 403) {
    kind = /quota|billing|exceeded/i.test(text) && status === 403 ? "quota_exhausted" : "auth";
  } else if (status === 404 || /model_not_found|model_decommissioned|does not exist|is not found|not supported for/i.test(text)) {
    kind = "model_not_found";
  } else if (/tool_use_failed|failed_generation|output_parse_failed|error parsing tool call/i.test(text)) {
    kind = "generation_failed";
  } else if (status === 408 || status === 504) {
    kind = "timeout";
  } else if (status >= 500) {
    kind = "server_error";
  } else if (status === 413 || /context_length|maximum context|too many tokens|request too large/i.test(text)) {
    kind = "context_length";
  } else if (/tool_use_failed|failed_generation|output_parse_failed|error parsing tool call/i.test(text)) {
    kind = "generation_failed";
  } else if (status === 400 && /API key not valid|API_KEY_INVALID|invalid api key/i.test(text)) {
    kind = "auth";
  } else if (status >= 400) {
    kind = "bad_request";
  } else {
    kind = "unknown";
  }

  return new ProviderError({
    provider,
    kind,
    status,
    code,
    retryAfterMs,
    details: info.rawBody ? info.rawBody.slice(0, 50_000) : undefined,
    message: `${PROVIDER_LABELS[provider]} HTTP ${status}: ${truncate(info.message, 500)}`
  });
}

/** Classify a non-HTTP failure (fetch rejection, abort, parse error). */
export function classifyThrown(provider: ProviderName, error: unknown, signal?: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  const err = error as { name?: string; message?: string; code?: string; cause?: { code?: string; name?: string } };
  const name = err?.name ?? "";
  const message = err?.message ?? String(error);
  const code = err?.code ?? err?.cause?.code;

  if (signal?.aborted && !(signal.reason instanceof TimeoutMarker)) {
    return new ProviderError({ provider, kind: "aborted", message: `${PROVIDER_LABELS[provider]} request cancelled`, cause: error });
  }
  if (
    name === "TimeoutError" ||
    error instanceof TimeoutMarker ||
    (signal?.reason instanceof TimeoutMarker) ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    /timed? ?out/i.test(message)
  ) {
    return new ProviderError({ provider, kind: "timeout", code, message: `${PROVIDER_LABELS[provider]} request timed out`, cause: error });
  }
  if (name === "AbortError") {
    return new ProviderError({ provider, kind: "aborted", message: `${PROVIDER_LABELS[provider]} request cancelled`, cause: error });
  }
  if (
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code ?? "") ||
    /fetch failed|network|socket hang up|ECONNRESET|ENOTFOUND/i.test(message)
  ) {
    return new ProviderError({ provider, kind: "network", code, message: `${PROVIDER_LABELS[provider]} network error: ${message}`, cause: error });
  }
  if (error instanceof SyntaxError) {
    return new ProviderError({ provider, kind: "invalid_response", message: `${PROVIDER_LABELS[provider]} returned malformed data: ${message}`, cause: error });
  }
  return new ProviderError({ provider, kind: "unknown", message: `${PROVIDER_LABELS[provider]} error: ${message}`, cause: error });
}

/** Marker used as an AbortSignal reason when *we* time a request out. */
export class TimeoutMarker extends Error {
  constructor(ms: number) {
    super(`Request exceeded ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Combine a caller signal with a per-request timeout. */
export function withTimeout(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutMarker(timeoutMs)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
