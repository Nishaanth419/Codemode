import { AgentRunner } from "../../src/agent/agent-runner.js";
import { EventBus, type AgentEvent } from "../../src/agent/event-bus.js";
import { ExecutionRouter } from "../../src/codemode/execution-router.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { AppDatabase } from "../../src/db/database.js";
import {
  GeminiProvider,
  GroqProvider,
  ProviderHealthTracker,
  ProviderRouter,
  RetryPolicy,
  type LLMProvider,
  type RouterEvent
} from "../../src/providers/index.js";
import type { NamespaceSpec } from "../../src/tools/registry.js";
import { MockLLM } from "./mock-llm.js";

export interface HarnessOptions {
  groq?: boolean;
  gemini?: boolean;
  autoFailover?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

export function makeRouter(mock: MockLLM, opts: HarnessOptions = {}) {
  const groq = new GroqProvider({ apiKey: opts.groq === false ? undefined : "gsk_test", fetch: mock.fetch, timeoutMs: opts.timeoutMs ?? 2_000 });
  const gemini = new GeminiProvider({ apiKey: opts.gemini === false ? undefined : "gem_test", fetch: mock.fetch, timeoutMs: opts.timeoutMs ?? 2_000 });
  const health = new ProviderHealthTracker();
  const router = new ProviderRouter({
    providers: [
      { provider: groq as LLMProvider, role: "primary" },
      { provider: gemini as LLMProvider, role: "fallback" }
    ],
    health,
    retryPolicy: new RetryPolicy({ maxRetries: opts.maxRetries ?? 2, baseDelayMs: 5, maxDelayMs: 10, maxRetryWaitMs: 50 }, () => 0.5),
    autoFailover: opts.autoFailover ?? true
  });
  const events: RouterEvent[] = [];
  return { router, health, groq, gemini, events, onEvent: (e: RouterEvent) => events.push(e) };
}

/** Test namespace with an execution counter, so duplicate runs are detectable. */
export function counterNamespace() {
  const state = { calls: 0, log: [] as string[] };
  const ns: NamespaceSpec = {
    name: "math",
    description: "Test math tools",
    tools: {
      add: {
        description: "Add two numbers",
        inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] },
        execute: async (args: { a: number; b: number }) => {
          state.calls++;
          state.log.push(`add(${args.a},${args.b})`);
          return { sum: args.a + args.b };
        }
      }
    }
  };
  return { ns, state };
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), CODEMODE_EXECUTOR: "local", CODEMODE_TIMEOUT_MS: 5_000, ...overrides };
}

export function makeAgent(mock: MockLLM, opts: HarnessOptions & { namespaces?: NamespaceSpec[] } = {}) {
  const r = makeRouter(mock, opts);
  const db = new AppDatabase(":memory:");
  const bus = new EventBus(db);
  const counter = counterNamespace();
  const runner = new AgentRunner({
    db,
    router: r.router,
    executionRouter: new ExecutionRouter(testConfig()),
    namespaces: opts.namespaces ?? [counter.ns],
    bus,
    maxSteps: 4
  });
  const events: AgentEvent[] = [];
  bus.subscribeAll((e) => events.push(e));
  return { ...r, db, bus, runner, counter, events, types: (t: string) => events.filter((e) => e.type === t) };
}
