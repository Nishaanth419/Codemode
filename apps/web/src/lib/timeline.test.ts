import { describe, expect, it } from "vitest";
import { applyEvent, initialTimeline } from "./timeline";
import type { AgentEvent } from "./types";

let id = 0;
const ev = (type: string, data: Record<string, unknown> = {}): AgentEvent => ({
  id: ++id,
  runId: "run_1",
  sessionId: "ses_1",
  type,
  data,
  createdAt: new Date().toISOString()
});

describe("timeline reducer", () => {
  it("builds the chat from a failover run", () => {
    const events = [
      ev("run.started", { userMessage: "add 1+2" }),
      ev("assistant.message", { text: "", provider: "groq", model: "openai/gpt-oss-120b", toolCalls: [{ id: "c1" }] }),
      ev("execution.started", { executionId: "e1", code: "async () => 1", provider: "groq", model: "openai/gpt-oss-120b", executorLabel: "Local" }),
      ev("tool.call", { executionId: "e1", callId: "e1:1", namespace: "sandbox", tool: "runPython", args: {} }),
      ev("tool.result", { executionId: "e1", callId: "e1:1", namespace: "sandbox", tool: "runPython", ok: true, durationMs: 300 }),
      ev("execution.completed", { executionId: "e1", ok: true, result: 3, durationMs: 400 }),
      ev("provider.failover", { from: "groq", to: "gemini", message: "Groq rate limit reached. Switching to Gemini." }),
      ev("assistant.message", { text: "The answer is 3", provider: "gemini", model: "gemini-3.6-flash" }),
      ev("run.completed", { provider: "gemini" })
    ];
    const s = events.reduce(applyEvent, initialTimeline);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "execution", "notice", "assistant"]);
    expect(s.items[1]).toMatchObject({ status: "completed", result: 3, toolCalls: [{ name: "sandbox.runPython", ok: true }] });
    expect(s.items[2]).toMatchObject({ level: "switch", text: "Groq rate limit reached. Switching to Gemini." });
    expect(s.items[3]).toMatchObject({ provider: "gemini", model: "gemini-3.6-flash" });
    expect(s.running).toBe(false);
    expect(s.lastProvider).toBe("gemini");
  });

  it("streams deltas and discards them on reset", () => {
    let s = applyEvent(initialTimeline, ev("run.started", { userMessage: "hi" }));
    s = applyEvent(s, { ...ev("assistant.delta", { text: "Hel", provider: "groq", step: 1 }), id: null });
    s = applyEvent(s, { ...ev("assistant.delta", { text: "lo", provider: "groq", step: 1 }), id: null });
    expect(s.items[1]).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    s = applyEvent(s, ev("assistant.reset", { provider: "groq" }));
    expect(s.items).toHaveLength(1);
  });

  it("surfaces run failures", () => {
    let s = applyEvent(initialTimeline, ev("run.started", { userMessage: "x" }));
    s = applyEvent(s, ev("run.failed", { message: "All LLM providers are unavailable.", error: { code: "LLM_UNAVAILABLE" } }));
    expect(s.items[1]).toMatchObject({ kind: "notice", level: "error", text: "All LLM providers are unavailable." });
    expect(s.running).toBe(false);
  });
});
