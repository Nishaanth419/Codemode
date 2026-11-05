/**
 * Folds the agent event stream into the chat timeline. Pure and deterministic:
 * replaying the persisted events of a session rebuilds the same view.
 */
import type { AgentEvent, ProviderName } from "./types";

export interface ToolCallView {
  callId: string;
  name: string;
  args: unknown;
  ok?: boolean;
  durationMs?: number;
  error?: string;
}

export interface OutputChunk {
  source: string;
  stream: "stdout" | "stderr" | "log";
  text: string;
}

export type ChatItem =
  | { kind: "user"; id: string; runId: string; text: string; at: string }
  | {
      kind: "assistant";
      id: string;
      runId: string;
      text: string;
      provider?: ProviderName;
      model?: string;
      streaming: boolean;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      latencyMs?: number;
      at: string;
    }
  | {
      kind: "execution";
      id: string;
      runId: string;
      code: string;
      provider: ProviderName;
      model: string;
      executor: string;
      status: "running" | "completed" | "failed";
      toolCalls: ToolCallView[];
      output: OutputChunk[];
      result?: unknown;
      error?: string;
      durationMs?: number;
      at: string;
    }
  | { kind: "notice"; id: string; runId: string; level: "info" | "warn" | "error" | "switch"; text: string; detail?: string; at: string };

export interface TimelineState {
  items: ChatItem[];
  running: boolean;
  activeRunId: string | null;
  lastProvider?: ProviderName;
  lastModel?: string;
  events: AgentEvent[];
}

export const initialTimeline: TimelineState = { items: [], running: false, activeRunId: null, events: [] };

const MAX_EVENTS = 2000;

export function applyEvent(state: TimelineState, e: AgentEvent): TimelineState {
  const events = e.type === "assistant.delta" ? state.events : [...state.events, e].slice(-MAX_EVENTS);
  const items = state.items.slice();
  const d = e.data;
  const streamingIdx = () => items.findIndex((i) => i.kind === "assistant" && i.streaming && i.runId === e.runId);
  const execIdx = (id: string) => items.findIndex((i) => i.kind === "execution" && i.id === id);
  const notice = (level: Extract<ChatItem, { kind: "notice" }>["level"], text: string, detail?: string) =>
    items.push({ kind: "notice", id: `n-${e.id ?? Math.random()}`, runId: e.runId, level, text, detail, at: e.createdAt });
  let { running, activeRunId, lastProvider, lastModel } = state;

  switch (e.type) {
    case "run.started":
      items.push({ kind: "user", id: `u-${e.runId}`, runId: e.runId, text: String(d.userMessage ?? ""), at: e.createdAt });
      running = true;
      activeRunId = e.runId;
      break;

    case "assistant.delta": {
      const idx = streamingIdx();
      if (idx >= 0) {
        const it = items[idx] as Extract<ChatItem, { kind: "assistant" }>;
        items[idx] = { ...it, text: it.text + d.text, provider: d.provider };
      } else {
        items.push({ kind: "assistant", id: `s-${e.runId}-${d.step}`, runId: e.runId, text: d.text, provider: d.provider, streaming: true, at: e.createdAt });
      }
      break;
    }

    case "assistant.reset":
    case "assistant.discarded": {
      const idx = streamingIdx();
      if (idx >= 0) items.splice(idx, 1);
      if (e.type === "assistant.discarded") notice("warn", "Reply discarded: it contained code that was never executed", String(d.reason ?? ""));
      break;
    }

    case "assistant.message": {
      const idx = streamingIdx();
      if (idx >= 0) items.splice(idx, 1);
      lastProvider = d.provider;
      lastModel = d.model;
      if (String(d.text ?? "").trim()) {
        items.push({
          kind: "assistant",
          id: `a-${e.id}`,
          runId: e.runId,
          text: d.text,
          provider: d.provider,
          model: d.model,
          usage: d.usage,
          latencyMs: d.latencyMs,
          streaming: false,
          at: e.createdAt
        });
      }
      break;
    }

    case "execution.started":
      items.push({
        kind: "execution",
        id: d.executionId,
        runId: e.runId,
        code: d.code,
        provider: d.provider,
        model: d.model,
        executor: d.executorLabel ?? d.executor,
        status: "running",
        toolCalls: [],
        output: [],
        at: e.createdAt
      });
      break;

    case "tool.call":
    case "tool.result":
    case "execution.log":
    case "execution.output":
    case "execution.completed":
    case "execution.failed": {
      const idx = execIdx(d.executionId);
      if (idx < 0) break;
      const it = { ...(items[idx] as Extract<ChatItem, { kind: "execution" }>) };
      if (e.type === "tool.call") {
        it.toolCalls = [...it.toolCalls, { callId: d.callId, name: `${d.namespace}.${d.tool}`, args: d.args }];
      } else if (e.type === "tool.result") {
        it.toolCalls = it.toolCalls.map((t) => (t.callId === d.callId ? { ...t, ok: d.ok, durationMs: d.durationMs, error: d.error } : t));
      } else if (e.type === "execution.log") {
        it.output = [...it.output, { source: "console", stream: "log", text: d.level === "log" || d.level === "info" ? d.line : `[${d.level}] ${d.line}` }];
      } else if (e.type === "execution.output") {
        it.output = [...it.output, { source: d.source, stream: d.stream, text: d.chunk }];
      } else {
        it.status = e.type === "execution.completed" ? "completed" : "failed";
        it.result = d.result;
        it.error = d.error;
        it.durationMs = d.durationMs;
      }
      items[idx] = it;
      break;
    }

    case "execution.deduplicated":
      notice("info", "Program already executed — result reused, not run again", String(d.reason ?? ""));
      break;

    case "provider.failover":
      notice("switch", String(d.message), d.retryAt ? `Retry after ${new Date(d.retryAt).toLocaleTimeString()}` : undefined);
      break;

    case "provider.retry":
      notice("info", `${capital(d.provider)}: ${d.reason}`, `Waiting ${Math.round(d.delayMs)}ms before retry`);
      break;

    case "tool.rejected":
      notice("warn", `Rejected tool call "${d.name}"`, d.reason);
      break;

    case "run.completed":
      running = false;
      activeRunId = null;
      break;

    case "run.failed":
      notice("error", String(d.message ?? "Run failed"), d.error?.code);
      running = false;
      activeRunId = null;
      break;

    case "run.cancelled":
      notice("warn", "Run cancelled");
      running = false;
      activeRunId = null;
      break;
  }
  return { items, running, activeRunId, lastProvider, lastModel, events };
}

function capital(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
