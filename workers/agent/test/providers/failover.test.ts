/**
 * Multi-provider failover: the ten required scenarios, using the real Groq/Gemini
 * provider code (and the real @google/genai SDK) with mocked HTTP responses.
 */
import { describe, expect, it } from "vitest";
import { LLMUnavailableError, ProviderError } from "../../src/providers/index.js";
import type { GenerateRequest } from "../../src/providers/index.js";
import { makeAgent, makeRouter } from "../helpers/harness.js";
import { MockLLM, gemini503, geminiError, groq401, groq429, groqError } from "../helpers/mock-llm.js";

const baseRequest: GenerateRequest = {
  system: "You are AgentOS. Use the codemode tool.",
  messages: [{ role: "user", content: "What is 2 + 2?" }],
  tools: [{ name: "codemode", description: "Execute code", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }]
};

const ADD_PROGRAM = "async () => { const r = await math.add({ a: 20, b: 22 }); return r.sum; }";

describe("1. Groq successful response", () => {
  it("serves the request from Groq without touching Gemini", async () => {
    const mock = new MockLLM().groq({ kind: "text", text: "4" });
    const { router, health, events, onEvent } = makeRouter(mock);

    const result = await router.generate(baseRequest, { onEvent });

    expect(result).toMatchObject({ provider: "groq", text: "4", model: "openai/gpt-oss-120b", finishReason: "stop" });
    expect(mock.calls("gemini")).toHaveLength(0);
    expect(mock.calls("groq")[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(mock.calls("groq")[0].headers.authorization).toBe("Bearer gsk_test");
    expect(events.map((e) => e.type)).toEqual(["provider.request", "provider.response"]);
    const snap = health.snapshot();
    expect(snap.currentProvider).toBe("groq");
    expect(snap.providers.find((p) => p.name === "groq")).toMatchObject({ status: "active", requestsMade: 1, successes: 1 });
    expect(snap.providers.find((p) => p.name === "gemini")).toMatchObject({ status: "standby", requestsMade: 0, quotaRemaining: null });
  });

  it("streams text deltas from Groq", async () => {
    const mock = new MockLLM().groq({ kind: "text", text: "The answer is four." });
    const { router } = makeRouter(mock);
    const deltas: string[] = [];
    const result = await router.stream(baseRequest, { onTextDelta: (t) => deltas.push(t) });
    expect(deltas.join("")).toBe("The answer is four.");
    expect(result.text).toBe("The answer is four.");
    expect(result.usage?.totalTokens).toBe(120);
  });
});

describe("2. Groq 429 triggers Gemini", () => {
  it("fails over on a rate limit and records the switch", async () => {
    const mock = new MockLLM().groq(groq429("30")).gemini({ kind: "text", text: "4 (from Gemini)" });
    const { router, health, events, onEvent } = makeRouter(mock);

    const result = await router.generate(baseRequest, { onEvent });

    expect(result.provider).toBe("gemini");
    expect(mock.calls("groq")).toHaveLength(1); // Retry-After 30s is longer than we wait, so no retry
    const failover = events.find((e) => e.type === "provider.failover");
    expect(failover).toMatchObject({ from: "groq", to: "gemini", message: "Groq rate limit reached. Switching to Gemini." });
    const groq = health.snapshot().providers.find((p) => p.name === "groq")!;
    expect(groq).toMatchObject({ status: "rate_limited", rateLimited: true, consecutiveFailures: 1 });
    expect(Date.parse(groq.retryAfter!) - Date.now()).toBeGreaterThan(25_000);
    expect(health.snapshot().currentProvider).toBe("gemini");
  });

  it("skips a rate-limited Groq on the next request until Retry-After passes", async () => {
    const mock = new MockLLM().groq(groq429("30")).gemini({ kind: "text", text: "a" }, { kind: "text", text: "b" });
    const { router, events, onEvent } = makeRouter(mock);
    await router.generate(baseRequest, { onEvent });
    events.length = 0;

    const second = await router.generate(baseRequest, { onEvent });

    expect(second.provider).toBe("gemini");
    expect(mock.calls("groq")).toHaveLength(1);
    expect(events.find((e) => e.type === "provider.failover")).toMatchObject({ from: "groq", to: "gemini" });
  });

  it("announces the switch once per run while Groq stays rate-limited", async () => {
    const mock = new MockLLM()
      .groq(groq429("60"))
      .gemini({ kind: "tool", code: "async () => (await math.add({ a: 1, b: 1 })).sum" }, { kind: "text", text: "2" });
    const agent = makeAgent(mock);
    await agent.runner.run("ses_once", "run_once", "1+1");
    expect(agent.types("provider.failover")).toHaveLength(1);
    expect(agent.types("provider.skipped")).toHaveLength(1);
    expect(mock.calls("groq")).toHaveLength(1);
  });

  it("honours a short Retry-After by retrying Groq instead of switching", async () => {
    const mock = new MockLLM().groq(groq429("0.01"), { kind: "text", text: "4" });
    const { router, events, onEvent } = makeRouter(mock);
    const result = await router.generate(baseRequest, { onEvent });
    expect(result.provider).toBe("groq");
    expect(mock.calls("gemini")).toHaveLength(0);
    expect(events.find((e) => e.type === "provider.retry")).toMatchObject({ provider: "groq", delayMs: 10 });
  });

  it("treats a daily-quota 429 as quota exhaustion and fails over without retrying", async () => {
    const mock = new MockLLM().groq(groq429("432", true)).gemini({ kind: "text", text: "ok" });
    const { router, health, events, onEvent } = makeRouter(mock);
    await router.generate(baseRequest, { onEvent });
    expect(mock.calls("groq")).toHaveLength(1);
    expect(events.find((e) => e.type === "provider.failover")).toMatchObject({ message: "Groq daily quota exhausted. Switching to Gemini." });
    expect(health.snapshot().providers[0].lastError?.kind).toBe("quota_exhausted");
  });
});

describe("3. Groq timeout triggers Gemini after retry", () => {
  it("retries Groq on timeout, then switches to Gemini", async () => {
    const mock = new MockLLM().groq({ kind: "hang" }, { kind: "hang" }, { kind: "hang" }).gemini({ kind: "text", text: "4" });
    const { router, events, onEvent } = makeRouter(mock, { timeoutMs: 40 });

    const result = await router.generate(baseRequest, { onEvent });

    expect(result.provider).toBe("gemini");
    expect(mock.calls("groq")).toHaveLength(3); // 1 attempt + 2 bounded retries
    const retries = events.filter((e) => e.type === "provider.retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ provider: "groq", error: { kind: "timeout" } });
    expect(events.find((e) => e.type === "provider.failover")).toMatchObject({
      from: "groq",
      to: "gemini",
      message: "Groq request timed out after 3 attempts. Switching to Gemini."
    });
  });

  it("recovers on Groq when a retry succeeds", async () => {
    const mock = new MockLLM().groq({ kind: "hang" }, { kind: "text", text: "4" });
    const { router } = makeRouter(mock, { timeoutMs: 40 });
    const result = await router.generate(baseRequest);
    expect(result.provider).toBe("groq");
    expect(mock.calls("gemini")).toHaveLength(0);
  });
});

describe("4. Groq 5xx triggers fallback", () => {
  it.each([500, 502, 503])("HTTP %i is retried then falls back to Gemini", async (status) => {
    const mock = new MockLLM().groq(groqError(status), groqError(status), groqError(status)).gemini({ kind: "text", text: "4" });
    const { router, events, onEvent } = makeRouter(mock);
    const result = await router.generate(baseRequest, { onEvent });
    expect(result.provider).toBe("gemini");
    expect(mock.calls("groq")).toHaveLength(3);
    expect(events.find((e) => e.type === "provider.failover")).toMatchObject({ reason: expect.stringContaining(`HTTP ${status}`) });
  });

  it("network errors also fall back", async () => {
    const mock = new MockLLM().groq({ kind: "network" }, { kind: "network" }, { kind: "network" }).gemini({ kind: "text", text: "4" });
    const { router } = makeRouter(mock);
    expect((await router.generate(baseRequest)).provider).toBe("gemini");
  });

  it("an empty completion (no text, no tool call) is retried, then falls back", async () => {
    // e.g. a reasoning model that spends its whole output on reasoning and stops.
    const empty = { kind: "text" as const, text: "" };
    const mock = new MockLLM().groq(empty, empty, empty).gemini({ kind: "text", text: "4" });
    const { router, events, onEvent } = makeRouter(mock);
    const result = await router.stream(baseRequest, { onEvent });
    expect(result).toMatchObject({ provider: "gemini", text: "4" });
    expect(mock.calls("groq")).toHaveLength(3);
    expect(events.find((e) => e.type === "provider.failover")).toMatchObject({ message: "Groq returned an empty response after 3 attempts. Switching to Gemini." });
  });

  it("an empty completion recovers on the same provider when a retry succeeds", async () => {
    const mock = new MockLLM().groq({ kind: "text", text: "" }, { kind: "text", text: "4" });
    const { router } = makeRouter(mock);
    expect(await router.generate(baseRequest)).toMatchObject({ provider: "groq", text: "4" });
    expect(mock.calls("gemini")).toHaveLength(0);
  });
});

describe("5. Invalid Groq API key does not silently fall back", () => {
  it("throws an auth error and never calls Gemini", async () => {
    const mock = new MockLLM().groq(groq401).gemini({ kind: "text", text: "should not be used" });
    const { router, health, events, onEvent } = makeRouter(mock);

    const err = await router.generate(baseRequest, { onEvent }).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "auth", provider: "groq", status: 401 });
    expect(mock.calls("groq")).toHaveLength(1); // not retried
    expect(mock.calls("gemini")).toHaveLength(0);
    expect(events.some((e) => e.type === "provider.failover")).toBe(false);
    expect(events.find((e) => e.type === "provider.error")).toMatchObject({ willFailover: false });
    expect(health.snapshot().providers[0].status).toBe("unavailable");
  });

  it.each([
    ["malformed request", groqError(400, "'messages' must contain at least one message", "invalid_request_error")],
    ["unsupported model", groqError(404, "The model `openai/gpt-oss-999b` does not exist or you do not have access to it.", "model_not_found")]
  ])("%s is surfaced, not hidden behind a fallback", async (_label, reply) => {
    const mock = new MockLLM().groq(reply).gemini({ kind: "text", text: "nope" });
    const { router } = makeRouter(mock);
    await expect(router.generate(baseRequest)).rejects.toBeInstanceOf(ProviderError);
    expect(mock.calls("gemini")).toHaveLength(0);
  });

  it("the agent reports the configuration error to the frontend", async () => {
    const mock = new MockLLM().groq(groq401);
    const agent = makeAgent(mock);
    const outcome = await agent.runner.run("ses_auth", "run_auth", "hello");
    expect(outcome.status).toBe("failed");
    const failed = agent.types("run.failed")[0];
    expect(failed.data.message).toMatch(/Groq rejected the API key.*GROQ_API_KEY/);
    expect(mock.calls("gemini")).toHaveLength(0);
  });
});

describe("6. Gemini unavailable returns a useful error", () => {
  it("Gemini-only deployment: explains the outage and that no fallback exists", async () => {
    const mock = new MockLLM().gemini(gemini503, gemini503, gemini503);
    const { router } = makeRouter(mock, { groq: false });

    const err = await router.generate(baseRequest).catch((e) => e);

    expect(err).toBeInstanceOf(LLMUnavailableError);
    expect(err.message).toContain("Gemini: Gemini server error (HTTP 503)");
    expect(err.message).toContain("No fallback provider is configured (only Gemini)");
    expect(mock.calls("gemini")).toHaveLength(3);
    expect(mock.calls("groq")).toHaveLength(0);
  });

  it("parses Gemini RESOURCE_EXHAUSTED with RetryInfo and per-day quota ids", async () => {
    const mock = new MockLLM().gemini(
      geminiError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaMetric: "generativelanguage.googleapis.com/generate_requests" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }
      ])
    );
    const { router, health } = makeRouter(mock, { groq: false });
    const err = await router.generate(baseRequest).catch((e) => e);
    expect(err).toBeInstanceOf(LLMUnavailableError);
    expect(err.attempts[0]).toMatchObject({ kind: "quota_exhausted", retryAfterMs: 37_000 });
    expect(health.snapshot().providers[1]).toMatchObject({ status: "rate_limited" });
    expect(err.retryAt).not.toBeNull();
  });

  it("an invalid Gemini key during failover is reported as a configuration error", async () => {
    const mock = new MockLLM()
      .groq(groq429("60"))
      .gemini(geminiError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }]));
    const { router } = makeRouter(mock);
    const err = await router.generate(baseRequest).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: "gemini", kind: "auth" });
  });
});

describe("7. Both providers unavailable", () => {
  it("throws LLMUnavailableError listing both providers", async () => {
    const mock = new MockLLM()
      .groq(groqError(503), groqError(503), groqError(503))
      .gemini(gemini503, gemini503, gemini503);
    const { router, health } = makeRouter(mock);

    const err = await router.generate(baseRequest).catch((e) => e);

    expect(err).toBeInstanceOf(LLMUnavailableError);
    expect(err.code).toBe("LLM_UNAVAILABLE");
    expect(err.attempts.map((a: ProviderError) => a.provider)).toEqual(["groq", "gemini"]);
    expect(err.message).toMatch(/All LLM providers are unavailable\. Groq: .*503.*; Gemini: .*503/);
    // Three consecutive failures open each provider's circuit for a cool-down period.
    expect(health.snapshot().providers.map((p) => p.status)).toEqual(["unavailable", "unavailable"]);
    expect(health.snapshot().currentProvider).toBeNull();
  });

  it("the agent emits run.failed with LLM_UNAVAILABLE for the frontend", async () => {
    const mock = new MockLLM();
    mock.fallback.groq = groq429("120");
    mock.fallback.gemini = geminiError(429, "RESOURCE_EXHAUSTED", "Quota exceeded", [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }]);
    const agent = makeAgent(mock);
    const outcome = await agent.runner.run("ses_down", "run_down", "hi");
    expect(outcome.status).toBe("failed");
    const failed = agent.types("run.failed")[0];
    expect(failed.data.error).toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(String(failed.data.message)).toContain("Groq: Groq rate limit reached; Gemini: Gemini rate limit reached");
    expect(String(failed.data.message)).toMatch(/Try again after/);
    expect(agent.db.getRun("run_down")?.status).toBe("failed");
  });

  it("with no provider configured, explains which keys to set", async () => {
    const { router } = makeRouter(new MockLLM(), { groq: false, gemini: false });
    await expect(router.generate(baseRequest)).rejects.toThrow(/Set GROQ_API_KEY and\/or GEMINI_API_KEY/);
  });
});

describe("8. Conversation history survives provider switching", () => {
  it("Gemini receives the same system prompt, prior turns and Code Mode tool after a switch", async () => {
    const mock = new MockLLM()
      .groq({ kind: "text", text: "Hello! I am AgentOS." }) // run 1 on Groq
      .groq(groq429("60")) // run 2: Groq rate limited
      .gemini({ kind: "text", text: "Your name is Ada." });
    const agent = makeAgent(mock);

    await agent.runner.run("ses_hist", "run_1", "Hi, my name is Ada.");
    await agent.runner.run("ses_hist", "run_2", "What is my name?");

    const groqBody = mock.calls("groq")[0].body;
    const geminiBody = mock.calls("gemini")[0].body;
    // System prompt (with Code Mode instructions) identical on both providers.
    const groqSystem = groqBody.messages[0].content;
    expect(groqSystem).toContain("# Code Mode");
    expect(geminiBody.systemInstruction.parts[0].text).toBe(groqSystem);
    // Full conversation.
    expect(geminiBody.contents).toEqual([
      { role: "user", parts: [{ text: "Hi, my name is Ada." }] },
      { role: "model", parts: [{ text: "Hello! I am AgentOS." }] },
      { role: "user", parts: [{ text: "What is my name?" }] }
    ]);
    // Same logical tool: one `codemode` function with the generated TypeScript API.
    const groqTool = groqBody.tools[0].function;
    const geminiTool = geminiBody.tools[0].functionDeclarations[0];
    expect(geminiTool.name).toBe("codemode");
    expect(geminiTool.description).toBe(groqTool.description);
    expect(geminiTool.description).toContain("declare const math:");
    expect(geminiTool.parametersJsonSchema).toEqual(groqTool.parameters);
    // Execution history records which provider produced each turn.
    const msgs = agent.db.listMessages("ses_hist").map((m) => m.message);
    expect(msgs.filter((m) => m.role === "assistant").map((m) => (m as { provider?: string }).provider)).toEqual(["groq", "gemini"]);
    expect(agent.types("provider.failover")[0].data.message).toBe("Groq rate limit reached. Switching to Gemini.");
  });

  it("a mid-run switch hands Gemini the executed program and its result", async () => {
    const mock = new MockLLM()
      .groq({ kind: "tool", code: ADD_PROGRAM, id: "call_groq_1" })
      .groq(groqError(503), groqError(503), groqError(503))
      .gemini({ kind: "text", text: "20 + 22 = 42" });
    const agent = makeAgent(mock);

    const outcome = await agent.runner.run("ses_mid", "run_mid", "Add 20 and 22");

    expect(outcome).toMatchObject({ status: "completed", provider: "gemini", text: "20 + 22 = 42" });
    const contents = mock.calls("gemini")[0].body.contents;
    const flat = JSON.stringify(contents);
    expect(flat).toContain("Add 20 and 22");
    expect(flat).toContain("[Earlier tool call call_groq_1 by groq/openai/gpt-oss-120b] codemode(");
    expect(flat).toContain("already executed, do not re-run");
    expect(flat).toContain('\\"result\\":42');
    expect(agent.counter.state.calls).toBe(1);
  });
});

describe("9. Code Mode tool calling works with both providers", () => {
  it("Groq: tool call → sandboxed program → tool result → answer", async () => {
    const mock = new MockLLM().groq({ kind: "tool", code: ADD_PROGRAM }, { kind: "text", text: "The sum is 42." });
    const agent = makeAgent(mock);

    const outcome = await agent.runner.run("ses_groq_cm", "run_g", "Add 20 and 22");

    expect(outcome).toMatchObject({ status: "completed", provider: "groq", text: "The sum is 42." });
    expect(agent.counter.state.log).toEqual(["add(20,22)"]);
    const completed = agent.types("execution.completed")[0];
    expect(completed.data).toMatchObject({ ok: true, result: 42, provider: "groq" });
    expect(agent.types("tool.call")[0].data).toMatchObject({ namespace: "math", tool: "add", args: { a: 20, b: 22 } });
    // Second Groq request carries the tool result in OpenAI format.
    const followUp = mock.calls("groq")[1].body.messages;
    expect(followUp.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ type: "function", function: { name: "codemode" } }] });
    expect(followUp.at(-1)).toMatchObject({ role: "tool" });
    expect(JSON.parse(followUp.at(-1).content)).toMatchObject({ ok: true, result: 42 });
  });

  it("Gemini: functionCall → sandboxed program → functionResponse with thought signature replayed", async () => {
    const mock = new MockLLM().gemini({ kind: "tool", code: ADD_PROGRAM, thoughtSignature: "sig-XYZ" }, { kind: "text", text: "42" });
    const agent = makeAgent(mock, { groq: false });

    const outcome = await agent.runner.run("ses_gem_cm", "run_m", "Add 20 and 22");

    expect(outcome).toMatchObject({ status: "completed", provider: "gemini", text: "42" });
    expect(agent.counter.state.calls).toBe(1);
    const contents = mock.calls("gemini")[1].body.contents;
    expect(contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "codemode", args: { code: ADD_PROGRAM } }, thoughtSignature: "sig-XYZ" }]
    });
    expect(contents[2].role).toBe("user");
    expect(contents[2].parts[0].functionResponse).toMatchObject({ name: "codemode", response: { ok: true, result: 42 } });
  });

  it("a failing program returns the error to the model, which can fix it", async () => {
    const mock = new MockLLM()
      .groq({ kind: "tool", code: "async () => { return await math.multiply({ a: 1 }); }" })
      .groq({ kind: "tool", code: ADD_PROGRAM })
      .groq({ kind: "text", text: "42" });
    const agent = makeAgent(mock);
    const outcome = await agent.runner.run("ses_fix", "run_fix", "go");
    expect(outcome.status).toBe("completed");
    expect(agent.types("execution.failed")[0].data.error).toContain('Tool "math.multiply" does not exist');
    expect(agent.types("execution.completed")).toHaveLength(1);
  });
});

describe("10. Previously executed code is never duplicated during failover", () => {
  it("a program re-emitted by Gemini after the switch reuses Groq's stored result", async () => {
    const mock = new MockLLM()
      .groq({ kind: "tool", code: ADD_PROGRAM, id: "call_1" }) // step 1 on Groq → executes
      .groq(groq429("60")) // step 2: Groq rate limited
      .gemini({ kind: "tool", code: ADD_PROGRAM }) // Gemini asks to run the same program again
      .gemini({ kind: "text", text: "It is 42." });
    const agent = makeAgent(mock);

    const outcome = await agent.runner.run("ses_dup", "run_dup", "Add 20 and 22");

    expect(outcome).toMatchObject({ status: "completed", provider: "gemini" });
    expect(agent.counter.state.calls).toBe(1); // executed exactly once
    expect(agent.types("execution.started")).toHaveLength(1);
    const dedup = agent.types("execution.deduplicated")[0];
    expect(dedup.data).toMatchObject({ originalProvider: "groq", provider: "gemini" });
    expect(String(dedup.data.reason)).toContain("reusing its result instead of running it again");
    const lastGemini = JSON.stringify(mock.calls("gemini")[1].body.contents);
    expect(lastGemini).toContain("it was not run again");
    expect(agent.db.countExecutions("run_dup")).toBe(1);
  });

  it("a provider failure mid-stream never executes anything from the partial response", async () => {
    const partial = { kind: "stream-error", partial: "Let me run " } as const;
    const mock = new MockLLM().groq(partial, partial, partial).gemini({ kind: "tool", code: ADD_PROGRAM }, { kind: "text", text: "42" });
    const agent = makeAgent(mock);

    const outcome = await agent.runner.run("ses_stream", "run_stream", "Add");

    expect(outcome).toMatchObject({ status: "completed", provider: "gemini" });
    expect(mock.calls("groq")).toHaveLength(3);
    expect(agent.counter.state.calls).toBe(1); // only Gemini's complete tool call ran
    expect(agent.types("provider.stream_reset")).toHaveLength(3);
    expect(agent.events.filter((e) => e.type === "assistant.reset")).toHaveLength(3);
  });

  it("the same tool call id is never executed twice", async () => {
    const mock = new MockLLM()
      .groq({ kind: "tool", code: ADD_PROGRAM, id: "call_same" })
      .groq({ kind: "tool", code: ADD_PROGRAM, id: "call_same" })
      .groq({ kind: "text", text: "done" });
    const agent = makeAgent(mock);
    await agent.runner.run("ses_same", "run_same", "go");
    expect(agent.counter.state.calls).toBe(1);
    expect(agent.types("execution.deduplicated")[0].data.toolCallId).toBe("call_same");
  });
});
