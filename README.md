# AgentOS

An AI workspace where you describe a task in natural language, and an LLM writes **one JavaScript program** that orchestrates typed tools. The program runs in an isolated executor, calls Python / Node.js / shell inside Docker, and every step is traced live in the UI. This is Cloudflare's **Code Mode** pattern (`@cloudflare/codemode`), running on free-tier and local infrastructure.

```
React workspace ──SSE──▶ Agent backend ──▶ LLM router ──▶ Groq ─(fails over)─▶ Gemini ─▶ (Ollama, optional)
 (Vite, Tailwind,          (Express, Zod,      │
  shadcn/ui, Monaco)        SQLite)            ▼  one `codemode` tool call: { code }
                                          Code Mode (@cloudflare/codemode: types, normalizeCode, runCode)
                                               │
                                          Execution router ──▶ local worker-isolate executor   (default, dev)
                                               │           └─▶ Docker container executor       (CODEMODE_EXECUTOR=docker)
                                               ▼  tool calls from the program
                                          fs.* · sandbox.runPython/runNode/runShell/installPackage · web.fetch · codemode.searchTools
                                                         └─▶ Docker sandbox (no network, read-only, limits)
```

## Quick start

Requirements: Node ≥ 22.13 (uses built-in `node:sqlite`), Docker, and at least one of a Groq key, a Gemini key, or a local Ollama.

```bash
npm install
npm run sandbox:build          # builds agentos-sandbox:latest (Python 3 + Node 24 + bash)
cp .env.example .env           # add GROQ_API_KEY and/or GEMINI_API_KEY
npm run dev                    # agent on :8787, web on :5173
```

Open http://localhost:5173.

**Docker Compose** (builds the sandbox image, agent and web; UI on http://localhost:8080):

```bash
docker compose up --build
docker compose --profile ollama up --build   # also starts an Ollama container
WEB_PORT=8088 docker compose up --build      # if port 8080 is taken
```

The agent container starts sandbox containers as siblings through `/var/run/docker.sock`. That gives it control of the host Docker daemon, which is fine for local development but not for multi-tenant hosting.

## LLM providers

| Role | Provider | Integration | Default model |
|---|---|---|---|
| Primary | Groq | OpenAI-compatible API `https://api.groq.com/openai/v1` (plain `fetch`) | `openai/gpt-oss-120b` |
| Fallback | Google Gemini | Official `@google/genai` SDK | `gemini-3.6-flash` |
| Optional | Ollama | OpenAI-compatible `/v1` endpoint | `gpt-oss:20b` |

Model choices were checked against the providers' docs in November 2026:

- `openai/gpt-oss-120b` is a Groq production model with tool use. Groq does not list parallel tool calls for it; AgentOS only needs one `codemode` call per step.
- `gemini-3.6-flash` is Gemini's stable Flash model with function calling and structured output. `gemini-2.5-flash` is deprecated. Free-tier limits differ by project and change often, so check AI Studio for yours.

No OpenAI or Anthropic credentials are used anywhere. All keys stay in the agent process. The browser only ever sees provider names, models and health.

The app runs with **Groq alone, Gemini alone, or both**. A provider without a key is listed as "No key" and never called. Ollama joins the chain when `OLLAMA_ENABLED=true`, or you can make it primary or fallback.

### Failover policy (`workers/agent/src/providers/`)

| File | Responsibility |
|---|---|
| `provider-interface.ts` | Common contract: text, streaming, tool calling, structured output, system prompt, history, error normalization |
| `groq-provider.ts`, `gemini-provider.ts`, `ollama-provider.ts` | Wire-format translation in both directions |
| `errors.ts` | Classifies every failure into a `ProviderError.kind` |
| `retry-policy.ts` | Retry on the same provider, fail over, or fail |
| `provider-router.ts` | Priority chain, failover, execution events |
| `provider-health.ts` | Availability, last success and error, consecutive failures, rate-limit status, retry-after, request counts |

| Failure | Retry same provider | Fail over |
|---|---|---|
| HTTP 429 (per-minute limit) | only if `Retry-After` ≤ `LLM_MAX_RETRY_WAIT_MS` | yes |
| HTTP 429 daily quota (Groq "per day (TPD/RPD)", Gemini `…PerDay…` quota id) | no | yes |
| HTTP 500 / 502 / 503 / 504, timeout, network error | yes, bounded (`LLM_MAX_RETRIES`, exponential backoff + jitter) | yes |
| Malformed tool call from the model (Groq `tool_use_failed`, Ollama "error parsing tool call", truncated stream) | yes, bounded | yes |
| HTTP 401/403 invalid key, malformed request, unknown/decommissioned model, context overflow | **no** | **no**: the error is shown to the user |

- A rate-limited provider is skipped until its retry-after time, then tried again automatically.
- Three consecutive transient failures open a 30 s circuit breaker.
- When every provider is down, the frontend gets `LLM_UNAVAILABLE` with each provider's reason and the earliest retry time.
- Remaining quota is never shown, because neither provider reports it for free-tier keys.

### Agent continuity across a switch

- Every provider receives the identical system prompt (including the Code Mode instructions), the full persisted conversation and the same `codemode` tool definition.
- Tool calls are normalized to one internal `ToolCall` shape.
- **Gemini thought signatures:** Gemini rejects replayed function calls without them. Calls Gemini made itself are replayed with their signatures. Calls made by Groq or Ollama are given to Gemini as plain-text transcripts ("already executed, do not re-run") followed by their stored result.
- **A program never runs twice because of a switch:**
  1. The router only talks to models. Code runs only after a provider call has fully succeeded, and partially streamed tool calls are discarded.
  2. Executions are keyed by (run, tool-call id), so the same call id never runs twice.
  3. After a switch, if the new provider emits a program identical to one that already completed in this run, the stored result is reused and an `execution.deduplicated` event is recorded.
- Failovers appear in the chat ("Groq rate limit reached. Switching to Gemini.") and in the execution timeline. Every assistant message and every execution records the provider and model that produced it.

## Code Mode

The agent uses the real `@cloudflare/codemode@0.5.6` APIs:

- `generateTypesFromJsonSchema` turns each tool namespace into TypeScript declarations for the prompt.
- `runCode` (which applies `normalizeCode`) executes the program through an `Executor`.
- `truncateResult` caps tool results before they go back to the model.

The LLM gets a single tool, `codemode`, with input `{ code }`; it never calls host tools directly. The package's main entry imports `cloudflare:workers`, so on Node a small shim (`workers/agent/src/shims/`) provides the three empty base classes it references.

**Executors.** Both implement the package's `Executor` interface (`execute(code, providers) → { result, error, logs }`) and share one runtime, `sandbox/codemode-runtime.mjs`.

| `CODEMODE_EXECUTOR` | What it is | Isolation |
|---|---|---|
| `local` (default) | **Development adapter.** A fresh V8 context in a worker thread | Empty env, no `require` / `process` / `fetch`, string-eval and Wasm disabled, only JSON strings cross the boundary, heap limit, hard timeout (thread terminated). `node:vm` is not a security boundary. |
| `docker` | The same runtime in a throwaway container | `--network none`, read-only root fs, `--cap-drop ALL`, no-new-privileges, memory / CPU / PID limits, hard timeout |

Neither is Cloudflare's managed **`DynamicWorkerExecutor`**. That one requires the Workers runtime with a Worker Loader binding (Dynamic Workers, which may need a paid plan), so AgentOS does not use it. Moving to Workers later means swapping `codemode/execution-router.ts`, not the agent.

## Tools available to programs

| Namespace | Tools |
|---|---|
| `fs` | `listFiles`, `readFile`, `writeFile`, `deleteFile`, all confined to the session workspace (path traversal and symlink escapes are rejected) |
| `sandbox` | `runPython`, `runNode`, `runShell` (Docker, no network, workspace mounted at `/workspace`), `installPackage` (pip/npm **allowlist** only; names and versions validated; argv only, no shell; network enabled only for the install; npm `--ignore-scripts`), `listAllowedPackages` |
| `web` | `fetch`: public http(s) only; private, loopback, link-local and metadata addresses are blocked, including after redirects; 200 KB cap |
| `codemode` | `searchTools`: tool discovery |

Files in the workspace appear as downloadable artifacts in the UI.

## UI

- **Left sidebar:** sessions, tool catalog, executor and sandbox status.
- **Centre:** the chat. Answers are rendered as Markdown and tagged with the model that wrote them. Each execution card shows the program, tool-call chips, sandbox output and return value. Retry and failover notices appear inline.
- **Right inspector** has five tabs:
  - **Timeline:** every execution event, live.
  - **Code:** Monaco viewer for each generated program.
  - **Terminal:** console output and sandbox stdout/stderr.
  - **Artifacts:** preview and download workspace files.
  - **History:** every execution, with provider and model.
- **Header:** live provider status.
  - Groq: Active / Rate Limited (with retry countdown) / Unavailable.
  - Gemini: Active / Standby / Rate Limited / Unavailable.
  - Plus which provider will serve the next request. Hover a provider for details.

Below 1280 px the inspector becomes a drawer, and below 1024 px the sidebar does too.

## Tests

```bash
npm test                 # backend (vitest) + frontend reducer tests
npm run test:smoke       # real API calls: Groq / Gemini when keys are set, Ollama when reachable
```

`workers/agent/test/providers/failover.test.ts` covers the ten required scenarios. It runs the real provider code (including the real `@google/genai` SDK) against mocked HTTP:

1. Groq success
2. Groq 429 triggers Gemini
3. Groq timeout triggers Gemini after retries
4. Groq 500/502/503 trigger fallback
5. An invalid Groq key does not silently fall back
6. Gemini unavailable returns a useful error
7. Both providers unavailable
8. History survives a switch, before a run and in the middle of one
9. Code Mode tool calling works on both providers
10. Executed code is never duplicated: re-emitted after a switch, interrupted mid-stream, or with the same tool-call id

The other suites cover error classification, retry and health, structured output, Gemini history conversion, executor escape attempts and limits, Docker sandbox isolation (network, read-only fs, timeout), workspace path safety and the package allowlist.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Provider health, executor, sandbox |
| GET | `/api/tools` | Namespaces with generated TypeScript |
| GET/POST/DELETE | `/api/sessions[/:id]` | Sessions (GET includes messages, runs, executions) |
| POST | `/api/sessions/:id/messages` | Start a run → `{ runId }` |
| POST | `/api/runs/:id/cancel` | Cancel a run |
| GET | `/api/sessions/:id/events` | SSE: replays persisted events, then live; supports `Last-Event-ID` |
| GET | `/api/executions[/:id]` | Execution history |
| GET | `/api/sessions/:id/files[/content\|/download]` | Workspace artifacts |
