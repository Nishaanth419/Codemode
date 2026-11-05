import { describe, expect, it } from "vitest";
import { hashCode, looksLikeUnexecutedProgram, sanitizeHistory } from "../../src/agent/agent-runner.js";
import { makeAgent } from "../helpers/harness.js";
import { MockLLM } from "../helpers/mock-llm.js";

const ADD = "async () => (await math.add({ a: 1, b: 2 })).sum";

describe("agent loop", () => {
  it("persists runs, messages with provider/model, executions and events", async () => {
    const mock = new MockLLM().groq({ kind: "tool", code: ADD }, { kind: "text", text: "3" });
    const agent = makeAgent(mock);
    const outcome = await agent.runner.run("ses_p", "run_p", "1+2?");
    expect(outcome.status).toBe("completed");

    const run = agent.db.getRun("run_p")!;
    expect(run).toMatchObject({ status: "completed", provider: "groq", model: "openai/gpt-oss-120b" });
    const [exec] = agent.db.listExecutions("ses_p");
    expect(exec).toMatchObject({ status: "completed", provider: "groq", executor: "local-worker", result: "3" });
    const types = agent.db.listEvents({ runId: "run_p" }).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["run.started", "provider.request", "assistant.message", "execution.started", "tool.call", "tool.result", "execution.completed", "run.completed"])
    );
    // Streaming deltas are pushed live but not stored.
    expect(types).not.toContain("assistant.delta");
    expect(agent.db.getSession("ses_p")?.title).toBe("1+2?");
  });

  it("rejects a program written in the reply and asks the model to execute it", async () => {
    const fake = "I ran this:\n```js\nasync () => { const r = await math.add({a:1,b:2}); return r.sum; }\n```\nThe result is 3.";
    const mock = new MockLLM().groq({ kind: "text", text: fake }, { kind: "tool", code: ADD }, { kind: "text", text: "3 (verified)" });
    const agent = makeAgent(mock);
    const outcome = await agent.runner.run("ses_fake", "run_fake", "1+2?");
    expect(outcome.text).toBe("3 (verified)");
    expect(agent.types("assistant.discarded")).toHaveLength(1);
    expect(agent.counter.state.calls).toBe(1);
    const nudged = mock.calls("groq")[1].body.messages.at(-1);
    expect(nudged.content).toContain("did not call the codemode tool");
  });

  it("stops after the step budget and forces a final answer without tools", async () => {
    const mock = new MockLLM();
    mock.fallback.groq = { kind: "tool", code: ADD };
    const agent = makeAgent(mock); // maxSteps = 4
    mock.groq({ kind: "tool", code: ADD }, { kind: "tool", code: ADD }, { kind: "tool", code: ADD }, { kind: "tool", code: ADD }, { kind: "text", text: "final" });
    const outcome = await agent.runner.run("ses_steps", "run_steps", "loop");
    expect(outcome.text).toBe("final");
    // Tools stay declared (history contains tool calls) but calling them is forbidden.
    expect(mock.calls("groq").at(-1)!.body.tool_choice).toBe("none");
  });

  it("never executes a tool call made on the final, answer-only step", async () => {
    const mock = new MockLLM();
    mock.fallback.groq = { kind: "tool", code: ADD }; // the model keeps calling tools, even on the last step
    const agent = makeAgent(mock); // maxSteps = 4
    const outcome = await agent.runner.run("ses_final", "run_final", "loop");
    expect(agent.counter.state.calls).toBe(4);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatchObject({ code: "STEP_LIMIT" });
    expect(outcome.error!.message).toMatch(/after 4 tool steps without a final answer/);
    expect(outcome.error!.message).not.toMatch(/ended unexpectedly/);
  });

  it("uses the final-step text and ignores tool calls made alongside it", async () => {
    const mock = new MockLLM();
    const agent = makeAgent(mock);
    const steps = Array.from({ length: 4 }, () => ({ kind: "tool" as const, code: ADD }));
    mock.groq(...steps, { kind: "text", text: "Here is what I found." });
    const outcome = await agent.runner.run("ses_final2", "run_final2", "loop");
    expect(outcome).toMatchObject({ status: "completed", text: "Here is what I found." });
    expect(agent.counter.state.calls).toBe(4);
  });

  it("never completes a run with an empty answer", async () => {
    const mock = new MockLLM();
    mock.fallback.groq = { kind: "text", text: "" };
    mock.fallback.gemini = { kind: "text", text: "" };
    const agent = makeAgent(mock);
    const outcome = await agent.runner.run("ses_empty", "run_empty", "hi");
    expect(outcome.status).toBe("failed");
    expect(agent.db.getRun("run_empty")!.status).toBe("failed");
    expect(agent.types("run.completed")).toHaveLength(0);
  });

  it("reports the last execution error when the step budget runs out", async () => {
    const mock = new MockLLM();
    mock.fallback.groq = { kind: "tool", code: "async () => { throw new Error('pip install failed') }" };
    const agent = makeAgent(mock);
    const outcome = await agent.runner.run("ses_final3", "run_final3", "loop");
    expect(outcome.status).toBe("failed");
    expect(outcome.error!.message).toContain("pip install failed");
  });

  it("supports cancellation", async () => {
    const mock = new MockLLM().groq({ kind: "hang" });
    const agent = makeAgent(mock, { timeoutMs: 10_000 });
    const { runId, done } = agent.runner.start("ses_c", "hi");
    setTimeout(() => agent.runner.cancel(runId), 50);
    const outcome = await done;
    expect(outcome.status).toBe("cancelled");
    expect(agent.db.getRun(runId)?.status).toBe("cancelled");
    expect(mock.calls("gemini")).toHaveLength(0);
  });

  it("allows one active run per session", () => {
    const mock = new MockLLM().groq({ kind: "hang" });
    const agent = makeAgent(mock, { timeoutMs: 200, maxRetries: 0 });
    agent.runner.start("ses_busy", "a");
    expect(() => agent.runner.start("ses_busy", "b")).toThrow(/already in progress/);
  });
});

describe("history helpers", () => {
  it("adds placeholder results for interrupted tool calls", () => {
    const out = sanitizeHistory([
      { role: "user", content: "x" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "codemode", arguments: {} }, { id: "b", name: "codemode", arguments: {} }] },
      { role: "tool", toolCallId: "a", toolName: "codemode", content: "{}" },
      { role: "user", content: "y" }
    ]);
    expect(out.map((m) => (m.role === "tool" ? `tool:${m.toolCallId}` : m.role))).toEqual(["user", "assistant", "tool:a", "tool:b", "user"]);
  });

  it("code hashing ignores formatting differences", () => {
    expect(hashCode("async () => {  return 1 }")).toBe(hashCode("async () => {\n return 1\n}"));
    expect(hashCode("async () => 1")).not.toBe(hashCode("async () => 2"));
  });

  it("detects pasted, unexecuted programs", () => {
    expect(looksLikeUnexecutedProgram("```js\nasync () => { await sandbox.runPython({code:'1'}) }\n```")).toBe(true);
    expect(looksLikeUnexecutedProgram("Here is an example in Python:\n```python\nprint(1)\n```")).toBe(false);
  });
});
