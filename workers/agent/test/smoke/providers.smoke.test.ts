/**
 * Real-API smoke tests. Each block runs only when its credentials / endpoint exist:
 *   GROQ_API_KEY      → Groq
 *   GEMINI_API_KEY    → Gemini
 *   Ollama reachable  → Ollama (OLLAMA_BASE_URL, OLLAMA_MODEL)
 * Run with: npm run test:smoke   (reads the repo-root .env)
 */
import path from "node:path";
import { config as dotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../../src/agent/agent-runner.js";
import { EventBus } from "../../src/agent/event-bus.js";
import { ExecutionRouter } from "../../src/codemode/execution-router.js";
import { REPO_ROOT, loadConfig } from "../../src/config.js";
import { AppDatabase } from "../../src/db/database.js";
import {
  GeminiProvider,
  GroqProvider,
  OllamaProvider,
  ProviderHealthTracker,
  ProviderRouter,
  type LLMProvider
} from "../../src/providers/index.js";
import { buildCodeToolDefinition } from "../../src/codemode/code-tool.js";
import { counterNamespace } from "../helpers/harness.js";

dotenv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
const config = loadConfig();

const ollamaUp = await fetch(config.OLLAMA_BASE_URL.replace(/\/v1\/?$/, "") + "/api/tags", { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);

const providers: [string, boolean, () => LLMProvider][] = [
  ["groq", Boolean(config.GROQ_API_KEY), () => new GroqProvider({ apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL })],
  ["gemini", Boolean(config.GEMINI_API_KEY), () => new GeminiProvider({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL })],
  ["ollama", ollamaUp, () => new OllamaProvider({ enabled: true, baseUrl: config.OLLAMA_BASE_URL, model: config.OLLAMA_MODEL })]
];

for (const [name, enabled, make] of providers) {
  describe.skipIf(!enabled)(`${name} (real API)`, () => {
    it("generates text", async () => {
      const p = make();
      const r = await p.generate({ system: "Reply with exactly: pong", messages: [{ role: "user", content: "ping" }] });
      expect(r.text.toLowerCase()).toContain("pong");
      console.log(`[smoke] ${name} ${r.model} ${r.latencyMs}ms`);
    }, 180_000);

    it("returns a Code Mode tool call and completes an agent run", async () => {
      const p = make();
      const counter = counterNamespace();
      const health = new ProviderHealthTracker();
      const router = new ProviderRouter({ providers: [{ provider: p, role: "primary" }], health });
      const db = new AppDatabase(":memory:");
      const runner = new AgentRunner({
        db,
        router,
        executionRouter: new ExecutionRouter({ ...config, CODEMODE_EXECUTOR: "local" }),
        namespaces: [counter.ns],
        bus: new EventBus(db),
        maxSteps: 4
      });
      const outcome = await runner.run(`ses_smoke_${name}`, `run_smoke_${name}`, "Use the codemode tool to add 1234 and 4321 with math.add, then tell me the sum.");
      expect(outcome.status).toBe("completed");
      expect(counter.state.calls).toBeGreaterThanOrEqual(1);
      expect(outcome.text).toContain("5555");
      expect(buildCodeToolDefinition([counter.ns]).name).toBe("codemode");
    }, 300_000);
  });
}

describe.skipIf(!(config.GROQ_API_KEY && config.GEMINI_API_KEY))("groq → gemini failover with real APIs", () => {
  it("continues on Gemini when Groq is forced to fail", async () => {
    // Simulate an outage: every Groq call returns 503.
    const failing = new GroqProvider({
      apiKey: config.GROQ_API_KEY,
      fetch: async () => new Response(JSON.stringify({ error: { message: "Service Unavailable" } }), { status: 503, headers: { "content-type": "application/json" } })
    });
    const gemini = new GeminiProvider({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL });
    const router = new ProviderRouter({
      providers: [
        { provider: failing, role: "primary" },
        { provider: gemini, role: "fallback" }
      ],
      health: new ProviderHealthTracker()
    });
    const events: string[] = [];
    const r = await router.generate(
      { system: "Reply with exactly: pong", messages: [{ role: "user", content: "ping" }] },
      { onEvent: (e) => events.push(e.type === "provider.failover" ? e.message : e.type) }
    );
    expect(r.provider).toBe("gemini");
    expect(events).toContain("Groq server error (HTTP 503) after 3 attempts. Switching to Gemini.");
  }, 120_000);
});
