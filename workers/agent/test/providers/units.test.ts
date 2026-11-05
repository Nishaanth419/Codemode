import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GeminiProvider,
  OllamaProvider,
  ProviderError,
  ProviderHealthTracker,
  RetryPolicy,
  classifyHttpError,
  parseDurationMs,
  parseRetryAfter
} from "../../src/providers/index.js";
import type { ChatMessage } from "../../src/providers/index.js";
import { makeRouter } from "../helpers/harness.js";
import { MockLLM } from "../helpers/mock-llm.js";

describe("error classification", () => {
  const cls = (status: number, message: string, extra: Partial<Parameters<typeof classifyHttpError>[0]> = {}) =>
    classifyHttpError({ provider: "groq", status, message, ...extra }).kind;

  it.each([
    [429, "requests per minute (RPM)", "rate_limit"],
    [429, "tokens per day (TPD): Limit 200000", "quota_exhausted"],
    [401, "Invalid API Key", "auth"],
    [403, "Forbidden", "auth"],
    [400, "API key not valid. Please pass a valid API key.", "auth"],
    [404, "model not found", "model_not_found"],
    [400, "The model `x` has been decommissioned (model_decommissioned)", "model_not_found"],
    [400, "Failed to call a function. tool_use_failed", "generation_failed"],
    [500, "error parsing tool call: raw='async () => {}'", "generation_failed"],
    [413, "Request too large", "context_length"],
    [400, "messages: field required", "bad_request"],
    [500, "Internal", "server_error"],
    [502, "Bad gateway", "server_error"],
    [503, "Overloaded", "server_error"],
    [504, "Gateway timeout", "timeout"]
  ])("HTTP %i %s → %s", (status, message, kind) => {
    expect(cls(status, message)).toBe(kind);
  });

  it("separates permanent from transient failures", () => {
    const auth = new ProviderError({ provider: "groq", kind: "auth", message: "x" });
    const rl = new ProviderError({ provider: "groq", kind: "rate_limit", message: "x" });
    expect([auth.permanent, auth.fallbackEligible, auth.transient]).toEqual([true, false, false]);
    expect([rl.permanent, rl.fallbackEligible, rl.transient]).toEqual([false, true, true]);
  });

  it("parses Retry-After headers and Groq/Gemini duration strings", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
    expect(parseRetryAfter("1.5")).toBe(1_500);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8_000);
    expect(parseDurationMs("7m12.5s")).toBe(432_500);
    expect(parseDurationMs("37s")).toBe(37_000);
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("garbage")).toBeUndefined();
  });
});

describe("retry policy", () => {
  const policy = new RetryPolicy({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, maxRetryWaitMs: 5000, jitter: 0 });
  const err = (kind: ProviderError["kind"], retryAfterMs?: number) => new ProviderError({ provider: "groq", kind, message: "x", retryAfterMs });

  it("retries transient errors with exponential backoff, then fails over", () => {
    expect(policy.decide(err("server_error"), 0)).toMatchObject({ action: "retry", delayMs: 100 });
    expect(policy.decide(err("server_error"), 1)).toMatchObject({ action: "retry", delayMs: 200 });
    expect(policy.decide(err("server_error"), 2)).toMatchObject({ action: "failover" });
  });

  it("respects Retry-After within the wait budget", () => {
    expect(policy.decide(err("rate_limit", 2000), 0)).toMatchObject({ action: "retry", delayMs: 2000 });
    expect(policy.decide(err("rate_limit", 60_000), 0)).toMatchObject({ action: "failover" });
    expect(policy.decide(err("rate_limit"), 0)).toMatchObject({ action: "failover" });
  });

  it("never retries or fails over on permanent errors", () => {
    for (const kind of ["auth", "bad_request", "model_not_found", "context_length", "aborted"] as const) {
      expect(policy.decide(err(kind), 0).action).toBe("fail");
    }
    expect(policy.decide(err("quota_exhausted"), 0).action).toBe("failover");
  });
});

describe("provider health", () => {
  it("tracks rate limits, circuit breaking and recovery", () => {
    let now = 1_000_000;
    const h = new ProviderHealthTracker({ now: () => now, circuitThreshold: 2, circuitCooldownMs: 10_000 });
    h.register("groq", { model: "m", role: "primary", configured: true });
    h.register("gemini", { model: "g", role: "fallback", configured: true });
    expect(h.snapshot().providers.map((p) => p.status)).toEqual(["active", "standby"]);

    h.recordFailure("groq", new ProviderError({ provider: "groq", kind: "rate_limit", message: "x", retryAfterMs: 5_000 }));
    expect(h.snapshot()).toMatchObject({ currentProvider: "gemini" });
    expect(h.snapshot().providers.map((p) => p.status)).toEqual(["rate_limited", "active"]);
    now += 5_001;
    expect(h.snapshot().providers[0].status).toBe("active");

    h.recordFailure("gemini", new ProviderError({ provider: "gemini", kind: "server_error", message: "x" }));
    h.recordFailure("gemini", new ProviderError({ provider: "gemini", kind: "server_error", message: "x" }));
    expect(h.snapshot().providers[1]).toMatchObject({ status: "unavailable", consecutiveFailures: 2 });
    now += 10_001;
    h.recordSuccess("gemini");
    expect(h.snapshot().providers[1]).toMatchObject({ status: "standby", consecutiveFailures: 0 });
  });

  it("unconfigured providers are listed but never available", () => {
    const h = new ProviderHealthTracker();
    h.register("groq", { model: "m", role: "primary", configured: false });
    expect(h.snapshot().providers[0].status).toBe("unconfigured");
    expect(h.currentProvider()).toBeNull();
  });
});

describe("structured output", () => {
  const schema = z.object({ title: z.string(), tags: z.array(z.string()) });
  const jsonSchema = { type: "object", properties: { title: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["title", "tags"] };

  it("Groq uses response_format json_schema and validates with Zod", async () => {
    const mock = new MockLLM().groq({ kind: "text", text: '{"title":"Fib","tags":["math"]}' });
    const { router } = makeRouter(mock);
    const out = await router.generateStructured({ system: "s", messages: [{ role: "user", content: "x" }], schema, jsonSchema, schemaName: "summary" });
    expect(out.object).toEqual({ title: "Fib", tags: ["math"] });
    expect(mock.calls("groq")[0].body.response_format).toEqual({ type: "json_schema", json_schema: { name: "summary", schema: jsonSchema } });
  });

  it("Gemini uses responseJsonSchema when it is the active provider", async () => {
    const mock = new MockLLM().gemini({ kind: "text", text: '{"title":"Fib","tags":[]}' });
    const { router } = makeRouter(mock, { groq: false });
    const out = await router.generateStructured({ system: "s", messages: [{ role: "user", content: "x" }], schema, jsonSchema, schemaName: "summary" });
    expect(out.object.title).toBe("Fib");
    expect(mock.calls("gemini")[0].body.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: jsonSchema });
  });

  it("invalid structured output is a retryable invalid_response", async () => {
    const mock = new MockLLM().groq({ kind: "text", text: '{"title":1}' }, { kind: "text", text: '{"title":"ok","tags":[]}' });
    const { router } = makeRouter(mock);
    const out = await router.generateStructured({ system: "s", messages: [{ role: "user", content: "x" }], schema, jsonSchema, schemaName: "s" });
    expect(out.object.title).toBe("ok");
    expect(mock.calls("groq")).toHaveLength(2);
  });
});

describe("Gemini history conversion", () => {
  const gemini = new GeminiProvider({ apiKey: "k" });

  it("replays Gemini calls with signatures and converts foreign calls to transcripts", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", provider: "groq", model: "openai/gpt-oss-120b", toolCalls: [{ id: "c1", name: "codemode", arguments: { code: "a" }, providerMeta: { provider: "groq" } }] },
      { role: "tool", toolCallId: "c1", toolName: "codemode", content: '{"ok":true,"result":1}' },
      { role: "assistant", content: "", provider: "gemini", toolCalls: [{ id: "c2", name: "codemode", arguments: { code: "b" }, providerMeta: { provider: "gemini", thoughtSignature: "S" } }] },
      { role: "tool", toolCallId: "c2", toolName: "codemode", content: '{"ok":true,"result":2}' }
    ];
    const contents = gemini.toContents(history);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user", "model", "user"]);
    expect(contents[1].parts![0].text).toContain("[Earlier tool call c1 by groq/openai/gpt-oss-120b] codemode(");
    expect(contents[2].parts![0].text).toContain("already executed, do not re-run");
    expect(contents[3].parts![0]).toEqual({ functionCall: { name: "codemode", args: { code: "b" } }, thoughtSignature: "S" });
    expect(contents[4].parts![0].functionResponse).toEqual({ name: "codemode", response: { ok: true, result: 2 } });
  });
});

describe("Ollama raw tool-call recovery", () => {
  it("turns Ollama's 'error parsing tool call' into a codemode call", async () => {
    const raw = "(async () => { return 1 })();";
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: `error parsing tool call: raw='${raw}', err=invalid character '(' looking for beginning of value` } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    const ollama = new OllamaProvider({ enabled: true, fetch: fetchImpl });
    const result = await ollama.generate({
      system: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "codemode", description: "d", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }]
    });
    expect(result.toolCalls[0]).toMatchObject({ name: "codemode", arguments: { code: raw } });
  });
});

describe("truncated streams", () => {
  it("a stream that closes with no output and no [DONE] is retried as generation_failed", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      const sse =
        calls === 1
          ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "", reasoning: "thinking" } }] })}\n\n`
          : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { GroqProvider, ProviderRouter } = await import("../../src/providers/index.js");
    const router = new ProviderRouter({
      providers: [{ provider: new GroqProvider({ apiKey: "k", fetch: fetchImpl }), role: "primary" }],
      health: new ProviderHealthTracker(),
      retryPolicy: new RetryPolicy({ baseDelayMs: 1, maxDelayMs: 2 })
    });
    const result = await router.stream({ system: "s", messages: [{ role: "user", content: "x" }] });
    expect(result.text).toBe("ok");
    expect(calls).toBe(2);
  });
});
