/**
 * The agent loop.
 *
 *   user message → LLM (via ProviderRouter, with failover) → codemode tool call
 *   → Code Mode executor → tool result → LLM → … → final answer
 *
 * Continuity guarantees across a provider switch:
 *   - Every LLM call receives the same system prompt, the full persisted conversation
 *     (including earlier tool calls and results) and the same `codemode` tool definition.
 *   - Programs are executed only after a provider call has fully succeeded, and the
 *     router never executes tools, so a failed/retried LLM call cannot run code.
 *   - The tool namespaces (built-in + connected MCP servers) are snapshotted when a run
 *     starts, so an MCP server connecting or dropping mid-run cannot change the tool
 *     definition between two LLM calls of the same run.
 *   - Executions are recorded per (run, tool call id). A tool call id that already ran
 *     is never run again, and after a provider switch a program identical to one that
 *     already completed in this run reuses the stored result instead of re-running.
 */
import { createHash, randomUUID } from "node:crypto";
import { normalizeCode, truncateResult } from "@cloudflare/codemode";
import { CODEMODE_TOOL_NAME, buildCodeToolDefinition, executeCodeMode } from "../codemode/code-tool.js";
import type { ExecutionRouter } from "../codemode/execution-router.js";
import type { AppDatabase, ExecutionRow } from "../db/database.js";
import { LLMUnavailableError, type ProviderRouter, type RouterEvent } from "../providers/provider-router.js";
import { ProviderError } from "../providers/errors.js";
import type { ChatMessage, GenerateRequest, GenerateResult, ProviderName, ToolCall } from "../providers/provider-interface.js";
import { PROVIDER_LABELS } from "../providers/provider-interface.js";
import type { NamespaceSpec } from "../tools/registry.js";
import type { EventBus } from "./event-bus.js";
import { buildSystemPrompt } from "./prompts.js";

export interface AgentRunnerDeps {
  db: AppDatabase;
  router: ProviderRouter;
  executionRouter: ExecutionRouter;
  /** Fixed list, or a function evaluated at the start of every run (MCP servers come and go). */
  namespaces: NamespaceSpec[] | (() => NamespaceSpec[]);
  /** Awaited before a run takes its namespace snapshot (e.g. MCP servers still connecting). */
  beforeRun?: () => Promise<void>;
  bus: EventBus;
  maxSteps?: number;
}

export interface RunOutcome {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  text: string;
  provider?: ProviderName;
  model?: string;
  error?: Record<string, unknown>;
}

export class AgentRunner {
  private readonly active = new Map<string, { runId: string; controller: AbortController }>();

  constructor(private readonly deps: AgentRunnerDeps) {}

  isBusy(sessionId: string) {
    return this.active.has(sessionId);
  }

  cancel(runId: string): boolean {
    for (const a of this.active.values()) {
      if (a.runId === runId) {
        a.controller.abort(new Error("Cancelled by user"));
        return true;
      }
    }
    return false;
  }

  /** Start a run and return its id immediately; progress is published on the event bus. */
  start(sessionId: string, userMessage: string): { runId: string; done: Promise<RunOutcome> } {
    if (this.active.has(sessionId)) throw new Error("A run is already in progress for this session");
    const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const controller = new AbortController();
    this.active.set(sessionId, { runId, controller });
    const done = this.run(sessionId, runId, userMessage, controller.signal).finally(() => this.active.delete(sessionId));
    return { runId, done };
  }

  async run(sessionId: string, runId: string, userMessage: string, signal?: AbortSignal): Promise<RunOutcome> {
    const { db, router, bus, executionRouter } = this.deps;
    const maxSteps = this.deps.maxSteps ?? 8;
    const emit = (type: string, data: Record<string, unknown> = {}, persist = true) => bus.publish(runId, sessionId, type, data, { persist });

    if (!db.getSession(sessionId)) db.createSession(sessionId, titleFrom(userMessage));
    db.createRun(runId, sessionId, userMessage);
    db.addMessage(sessionId, runId, { role: "user", content: userMessage });
    const session = db.getSession(sessionId)!;
    if (session.title === "New session") db.touchSession(sessionId, titleFrom(userMessage));
    else db.touchSession(sessionId);

    emit("run.started", { userMessage, executor: executionRouter.info.label, chain: router.chain().map((p) => ({ provider: p.name, model: p.model })) });

    await this.deps.beforeRun?.().catch(() => {});
    const namespaces = typeof this.deps.namespaces === "function" ? this.deps.namespaces() : this.deps.namespaces;
    const system = buildSystemPrompt({
      executorLabel: executionRouter.info.label,
      mcp: namespaces.filter((n) => n.source === "mcp").map((n) => ({ namespace: n.name, server: n.server ?? n.name, tools: Object.keys(n.tools).length }))
    });
    const tools = [buildCodeToolDefinition(namespaces)];
    let lastResult: GenerateResult | undefined;
    let executedBy: ProviderName | undefined;
    let providerSwitched = false;
    let nudge = false;
    let nudged = false;
    let lastFailure: string | undefined;

    const announced = new Set<string>();
    const onRouterEvent = (e: RouterEvent) => {
      const { type, ...rest } = e;
      if (e.type === "provider.failover") {
        providerSwitched = true;
        // Announce each switch once per run; later steps that skip the same provider are timeline-only.
        const key = `${e.from}->${e.to}:${e.error ? "error" : "skip"}`;
        if (!e.error && announced.has(`${e.from}->${e.to}:error`)) {
          emit("provider.skipped", rest as Record<string, unknown>);
          return;
        }
        if (announced.has(key)) {
          emit("provider.skipped", rest as Record<string, unknown>);
          return;
        }
        announced.add(key);
      }
      emit(type, rest as Record<string, unknown>);
    };

    try {
      for (let step = 1; step <= maxSteps + 1; step++) {
        if (signal?.aborted) throw new ProviderError({ provider: lastResult?.provider ?? "groq", kind: "aborted", message: "Cancelled by user" });
        const finalStep = step > maxSteps;
        const messages = sanitizeHistory(db.listMessages(sessionId).map((m) => m.message));
        if (nudge) messages.push({ role: "user", content: NUDGE });
        // On the final step the tools stay declared (the history contains tool calls, and some
        // providers reject that without declarations) but calling them is forbidden.
        const request: GenerateRequest = {
          system: finalStep ? `${system}\n\n${FINAL_STEP_INSTRUCTION}` : system,
          messages,
          tools,
          toolChoice: finalStep ? "none" : "auto",
          signal
        };

        emit("llm.request", { step, messages: messages.length });
        let streamed = "";
        const result = await router.stream(request, {
          signal,
          onEvent: onRouterEvent,
          onTextDelta: (text, provider) => {
            streamed += text;
            emit("assistant.delta", { text, provider, step }, false);
          },
          onReset: (provider, reason) => {
            streamed = "";
            emit("assistant.reset", { provider, reason, step }, false);
          }
        });
        if (lastResult && result.provider !== lastResult.provider) providerSwitched = true;
        lastResult = result;
        nudge = false;

        // A model may still emit tool calls on the final step. Never execute them.
        const toolCalls = finalStep ? [] : result.toolCalls;
        if (finalStep && result.toolCalls.length) {
          for (const call of result.toolCalls) {
            emit("tool.rejected", { toolCallId: call.id, name: call.name, reason: "The tool step budget is used up; this call was not executed." });
          }
        }
        if (finalStep && !result.text.trim()) {
          throw new StepLimitError(maxSteps, lastFailure);
        }
        // Guard against faked execution: a program written in the reply instead of a tool call.
        if (!toolCalls.length && !finalStep && !nudged && db.countExecutions(runId) === 0 && looksLikeUnexecutedProgram(result.text, namespaces.map((n) => n.name))) {
          nudged = true;
          nudge = true;
          emit("assistant.discarded", {
            step,
            provider: result.provider,
            model: result.model,
            reason: "The model wrote a program in its reply instead of calling the codemode tool; asking it to run the program."
          });
          continue;
        }
        db.addMessage(sessionId, runId, {
          role: "assistant",
          content: result.text,
          toolCalls: toolCalls.length ? toolCalls : undefined,
          provider: result.provider,
          model: result.model
        });
        emit("assistant.message", {
          step,
          text: result.text,
          provider: result.provider,
          providerLabel: PROVIDER_LABELS[result.provider],
          model: result.model,
          usage: result.usage,
          latencyMs: result.latencyMs,
          toolCalls: toolCalls.map((t) => ({ id: t.id, name: t.name }))
        });

        if (!toolCalls.length) {
          db.finishRun(runId, "completed", { provider: result.provider, model: result.model });
          emit("run.completed", { provider: result.provider, model: result.model, text: result.text, steps: step });
          return { runId, status: "completed", text: result.text, provider: result.provider, model: result.model };
        }

        for (const call of toolCalls) {
          const content = await this.handleToolCall({ sessionId, runId, call, result, signal, emit, providerSwitched, executedBy, namespaces });
          if (content.executed) executedBy = result.provider;
          lastFailure = failureOf(content.text);
          db.addMessage(sessionId, runId, { role: "tool", toolCallId: call.id, toolName: call.name, content: content.text });
        }
        providerSwitched = false;
      }
      // Unreachable: the final step either returns an answer or throws StepLimitError.
      throw new StepLimitError(maxSteps, lastFailure);
    } catch (err) {
      const aborted = signal?.aborted || (err instanceof ProviderError && err.kind === "aborted");
      const error = serializeError(err);
      db.finishRun(runId, aborted ? "cancelled" : "failed", { provider: lastResult?.provider, model: lastResult?.model, error });
      emit(aborted ? "run.cancelled" : "run.failed", { error, message: error.message });
      return { runId, status: aborted ? "cancelled" : "failed", text: "", error, provider: lastResult?.provider, model: lastResult?.model };
    }
  }

  private async handleToolCall(opts: {
    sessionId: string;
    runId: string;
    call: ToolCall;
    result: GenerateResult;
    signal?: AbortSignal;
    emit: (type: string, data?: Record<string, unknown>, persist?: boolean) => unknown;
    providerSwitched: boolean;
    executedBy?: ProviderName;
    namespaces: NamespaceSpec[];
  }): Promise<{ text: string; executed: boolean }> {
    const { db, executionRouter } = this.deps;
    const { sessionId, runId, call, result, emit, namespaces } = opts;

    if (call.name !== CODEMODE_TOOL_NAME) {
      emit("tool.rejected", { toolCallId: call.id, name: call.name });
      return { text: JSON.stringify({ error: `Unknown tool "${call.name}". Only "${CODEMODE_TOOL_NAME}" is available.` }), executed: false };
    }
    const code = typeof call.arguments.code === "string" ? call.arguments.code : undefined;
    if (!code?.trim()) {
      emit("tool.rejected", { toolCallId: call.id, name: call.name, reason: "missing code" });
      return { text: JSON.stringify({ error: 'The codemode tool requires a non-empty "code" string.' }), executed: false };
    }

    // Idempotency 1: this exact tool call already has an execution record.
    const byCallId = db.findExecutionByToolCall(runId, call.id);
    if (byCallId && byCallId.status !== "running") {
      emit("execution.deduplicated", { executionId: byCallId.id, toolCallId: call.id, reason: "This tool call was already executed; reusing its result." });
      return { text: toolResultText(byCallId), executed: false };
    }

    // Idempotency 2: after a provider switch, the new provider re-emits a program that already completed.
    const codeHash = hashCode(code);
    if (opts.providerSwitched) {
      const prior = db.findCompletedExecutionByHash(runId, codeHash);
      if (prior && prior.provider !== result.provider) {
        emit("execution.deduplicated", {
          executionId: prior.id,
          toolCallId: call.id,
          originalProvider: prior.provider,
          provider: result.provider,
          reason: `This program already ran on ${PROVIDER_LABELS[prior.provider as ProviderName] ?? prior.provider} before the provider switch; reusing its result instead of running it again.`
        });
        return { text: toolResultText(prior, true), executed: false };
      }
    }

    const executionId = `exec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const info = executionRouter.info;
    db.startExecution({
      id: executionId,
      run_id: runId,
      session_id: sessionId,
      tool_call_id: call.id,
      code,
      code_hash: codeHash,
      provider: result.provider,
      model: result.model,
      executor: info.id
    });
    emit("execution.started", {
      executionId,
      toolCallId: call.id,
      code,
      normalizedCode: normalizeCode(code),
      provider: result.provider,
      model: result.model,
      executor: info.id,
      executorLabel: info.label
    });

    const toolCalls: unknown[] = [];
    let logCount = 0;
    const executor = executionRouter.create({
      onLog: (level, line) => {
        if (logCount++ < 500) emit("execution.log", { executionId, level, line });
      }
    });
    const outcome = await executeCodeMode({
      code,
      executor,
      namespaces,
      ctx: {
        sessionId,
        runId,
        executionId,
        signal: opts.signal,
        onOutput: (source, stream, chunk) => emit("execution.output", { executionId, source, stream, chunk })
      },
      observer: {
        onToolCall: (e) => emit("tool.call", { executionId, ...e }),
        onToolResult: (e) => {
          toolCalls.push({ name: `${e.namespace}.${e.tool}`, ok: e.ok, durationMs: e.durationMs, error: e.error });
          emit("tool.result", { executionId, ...e });
        }
      }
    });

    db.finishExecution(executionId, { ...outcome, toolCalls });
    emit(outcome.ok ? "execution.completed" : "execution.failed", {
      executionId,
      toolCallId: call.id,
      ok: outcome.ok,
      result: outcome.ok ? truncateResult(outcome.result, { maxChars: 20_000 }) : undefined,
      error: outcome.error,
      logs: outcome.logs.length,
      durationMs: outcome.durationMs,
      provider: result.provider,
      model: result.model
    });
    return { text: toolResultText(db.getExecution(executionId)!), executed: true };
  }
}

const FINAL_STEP_INSTRUCTION =
  "You have used all tool steps. Do not call any tool. Answer now from the results so far: say what worked, what failed and why, and what the user could try next.";

/** The run used its whole tool budget and the model gave no final answer. */
export class StepLimitError extends Error {
  constructor(
    readonly maxSteps: number,
    readonly lastFailure?: string
  ) {
    super(
      `AgentOS stopped after ${maxSteps} tool steps without a final answer.` +
        (lastFailure ? ` The last execution failed with: ${lastFailure}` : " Open the last execution in the inspector for details.")
    );
    this.name = "StepLimitError";
  }
}

/** The error of a failed execution's tool-result text, or undefined when it succeeded. */
function failureOf(toolResultText: string): string | undefined {
  try {
    const r = JSON.parse(toolResultText) as { ok?: boolean; error?: unknown };
    if (r.ok !== false || r.error === undefined) return undefined;
    const msg = String(r.error).replace(/\s+/g, " ").trim();
    return msg.length > 300 ? `${msg.slice(0, 297)}…` : msg;
  } catch {
    return undefined;
  }
}

const NUDGE =
  "[AgentOS] Your previous reply contained a program but did not call the codemode tool, so nothing was executed. Call the codemode tool now with that program, then answer from the real result.";

/** Detects a JavaScript Code Mode program pasted into a reply instead of being executed. */
export function looksLikeUnexecutedProgram(text: string, namespaces: string[] = ["sandbox", "fs", "web", "codemode"]): boolean {
  const blocks = [...text.matchAll(/```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  const names = namespaces.map((n) => n.replace(/[^\w$]/g, "")).filter(Boolean).join("|");
  const call = new RegExp(`\\b(${names})\\.\\w+\\s*\\(`);
  return blocks.some((b) => /async\s*\(\s*\)\s*=>/.test(b) && call.test(b));
}

/** The tool-result message the LLM sees for an execution. */
export function toolResultText(row: ExecutionRow, reused = false): string {
  const logs: string[] = row.logs ? JSON.parse(row.logs) : [];
  const payload: Record<string, unknown> =
    row.status === "completed"
      ? { ok: true, result: row.result ? JSON.parse(row.result) : null }
      : { ok: false, error: row.error ?? "Execution failed" };
  if (logs.length) payload.logs = logs.slice(-50);
  payload.executionId = row.id;
  if (reused) payload.note = "Result reused from the earlier execution of this program; it was not run again.";
  return JSON.stringify(truncateResult(payload, { maxChars: 24_000 }));
}

export function hashCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code).replace(/\s+/g, " ").trim()).digest("hex");
}

/**
 * Make persisted history valid for any provider: every assistant tool call must be
 * followed by its result. Calls without a result (e.g. a run that crashed) get a
 * synthetic "not executed" result so no provider rejects the history.
 */
export function sanitizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role === "assistant" && m.toolCalls?.length) {
      const answered = new Set<string>();
      for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
        answered.add((messages[j] as Extract<ChatMessage, { role: "tool" }>).toolCallId);
      }
      const missing = m.toolCalls.filter((tc) => !answered.has(tc.id));
      // Push existing tool results first, then synthesize the missing ones.
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") out.push(messages[j++]);
      for (const tc of missing) {
        out.push({ role: "tool", toolCallId: tc.id, toolName: tc.name, content: JSON.stringify({ ok: false, error: "Not executed (the run was interrupted)." }) });
      }
      i = j - 1;
    }
  }
  return out;
}

function serializeError(err: unknown): Record<string, unknown> & { message: string } {
  if (err instanceof LLMUnavailableError) return { ...err.toJSON(), message: err.message };
  if (err instanceof StepLimitError) return { code: "STEP_LIMIT", maxSteps: err.maxSteps, message: err.message };
  if (err instanceof ProviderError) {
    const hint =
      err.kind === "auth"
        ? ` Check ${err.provider.toUpperCase()}_API_KEY. AgentOS does not fall back on configuration errors.`
        : err.kind === "model_not_found"
          ? ` Check ${err.provider.toUpperCase()}_MODEL.`
          : "";
    return { ...err.toJSON(), errorCode: "PROVIDER_ERROR", message: `${err.summary}.${hint} (${err.message})` };
  }
  return { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) };
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || "New session";
}
