# AgentOS

An AI workspace where you describe a task in natural language, and an LLM writes **one JavaScript program** that orchestrates typed tools. The program runs in an isolated executor, calls Python / Node.js / shell inside Docker, and every step is traced live in the UI. This is Cloudflare's **Code Mode** pattern (`@cloudflare/codemode`), running on free-tier and local infrastructure. [MCP servers](#mcp-servers) plug in the same way: each server's tools become a typed TypeScript API that programs call, while the model still sees one tool.

**New here?** Open the **How it works** page in the app (`/#how-it-works`), then read [System design](#system-design). Contributors and coding agents: see [AGENTS.md](AGENTS.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/architecture-dark.png">
  <img alt="AgentOS architecture: web workspace, agent backend (server, AgentRunner, ProviderRouter, codemode tool, executors, host tools, MCP client), LLM providers, MCP servers and the Docker sandbox" src="docs/images/architecture-light.png">
</picture>

**Interactive version:** [docs/architecture.html](docs/architecture.html) (download and open it in a browser for zoom, search, dark/light themes, motion and source links to each component).

## Quick start

Requirements: Node ≥ 22.13 (uses built-in `node:sqlite`), Docker, and at least one of a Groq key, a Gemini key, or a local Ollama.

```bash
./run.sh
```

That is the whole setup. `run.sh` checks Node, installs dependencies when `package-lock.json` changed, creates `.env` from `.env.example` on first run, builds the sandbox image, checks the ports, then starts the agent (:8787) and the web UI (:5173) together with labelled logs. Add your `GROQ_API_KEY` and/or `GEMINI_API_KEY` to `.env`. Ctrl+C stops both.

| Command | What it does |
|---|---|
| `./run.sh` | Check prerequisites, start agent + web |
| `./run.sh --open` | Same, then open the UI in your browser |
| `./run.sh check` | Only the checks; also lists settings from `.env.example` missing in your `.env` |
| `./run.sh test` | Typecheck + all tests |
| `./run.sh docker` | Full stack with Docker Compose |
| `AGENT_PORT=8788 WEB_PORT=5174 ./run.sh` | Use other ports |

`npm run dev` runs the same script. Manual steps, if you prefer: `npm install`, `npm run sandbox:build`, `cp .env.example .env`, then `npm run dev:agent` and `npm run dev:web` in two terminals.

`.env.example` sets `MCP_CONFIG_FILE=mcp.json`, which connects the keyless demo MCP server (`@modelcontextprotocol/server-everything`, started with `npx`). Remove the line to run without MCP.

Open http://localhost:5173.

**Docker Compose** (builds the sandbox image, agent and web; UI on http://localhost:8080):

```bash
docker compose up --build
docker compose --profile ollama up --build   # also starts an Ollama container
WEB_PORT=8088 docker compose up --build      # if port 8080 is taken
```

The agent container starts sandbox containers as siblings through `/var/run/docker.sock`. That gives it control of the host Docker daemon, which is fine for local development but not for multi-tenant hosting.

## System design

> New to the project? Open **How it works** in the app (header link, or http://localhost:5173/#how-it-works). It replays one run step by step, with a toggle that shows a Groq → Gemini failover. It is scripted, so it works without API keys.

### Goals

1. Let a model do multi-step work with **one round trip per plan**, not one per tool call.
2. Run model-written code **without trusting it**.
3. Keep working when a free-tier provider rate limits, **without changing the agent's behaviour** and **without ever running a program twice**.
4. Make every step **observable and replayable** in the UI.

### Why Code Mode

Classic tool calling makes the model emit one JSON tool call, wait for the result, read it, emit the next. Every intermediate result passes back through the context window. Code Mode turns the tool catalog into TypeScript declarations and gives the model a single `codemode` tool. The model writes the whole plan as a program, with loops, conditionals and `Promise.all`. Intermediate values stay inside the program, and only the final return value goes back to the model.

| | Classic tool calling | Code Mode |
|---|---|---|
| LLM calls for "run Python, then a shell command on its output, then answer" | 3 | 2 |
| Tools visible to the model | every tool, as JSON schemas | one tool; the rest are a typed API in its description |
| Control flow | the model, one step at a time | real JavaScript |
| Intermediate results in context | all of them | only what the program returns |

### Components

The [interactive architecture diagram](docs/architecture.html) shows the same components with links to their source. The Mermaid view below renders directly on GitHub.

```mermaid
flowchart LR
  subgraph Browser
    UI["Web workspace<br/>apps/web"]
  end
  subgraph Agent["Agent backend · workers/agent"]
    API["server.ts<br/>REST + SSE"]
    RUN["agent-runner.ts<br/>agent loop"]
    PR["provider-router.ts<br/>retry · failover · health"]
    CM["code-tool.ts<br/>types · runCode"]
    EX["execution-router.ts<br/>local | docker executor"]
    TOOLS["tools/registry.ts<br/>fs · sandbox · web · codemode"]
    MCP["mcp/<br/>MCP client · one namespace per server"]
    BUS["event-bus.ts"]
    DB[("SQLite<br/>.data/agentos.sqlite")]
  end
  subgraph Providers["LLM providers"]
    G["Groq"]
    GM["Gemini"]
    O["Ollama (optional)"]
  end
  SB["Docker sandbox<br/>python · node · bash"]
  MS["MCP servers<br/>stdio · Streamable HTTP"]
  WS[("Session workspace<br/>.data/workspaces/:id")]

  UI -- "POST message" --> API
  API -- "SSE events" --> UI
  API --> RUN
  RUN --> PR --> G & GM & O
  RUN --> CM --> EX
  EX -- "tool-call messages" --> TOOLS
  EX -- "tool-call messages" --> MCP
  MCP -- "tools/list · tools/call" --> MS
  TOOLS --> SB
  TOOLS --> WS
  SB --- WS
  RUN --> BUS --> DB
  BUS --> API
```

| Component | Responsibility | Must not |
|---|---|---|
| Web workspace | Chat, execution cards, inspector, provider status, How it works page | hold secrets or call providers |
| `server.ts` | REST routes, SSE stream with replay, zod validation | contain agent logic |
| `agent-runner.ts` | The loop: build request → router → execute `codemode` calls → append results → repeat (max `LLM_MAX_AGENT_STEPS`) | execute anything before a provider call fully succeeds |
| `providers/` | One `LLMProvider` interface over Groq / Gemini / Ollama, error classification, retry, failover, health | run code |
| `codemode/` | Generate types from tool schemas, define the `codemode` tool, run programs via `@cloudflare/codemode` `runCode` | expose host objects to the program |
| Executors + `codemode-runtime.mjs` | Run the program in a fresh V8 context (worker thread) or a container; forward tool calls to the host as JSON | allow `require`, `process`, `fetch`, `eval`, Wasm |
| `tools/registry.ts` | The host functions programs can call; validates args and reports each call | trust program input |
| `mcp/` | Connect to MCP servers, turn each server's tools into a namespace, call them, reconnect, report health | hand the program the client, a transport or a credential |
| `sandbox/` | Docker runner, workspace path safety, package allowlist | give containers network (except allowlisted installs) |
| `db/` + `event-bus.ts` | Persist sessions, runs, messages, executions, events; fan events out to SSE | drop persisted events |

### Request lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant UI as Web UI
  participant S as server.ts
  participant R as AgentRunner
  participant P as ProviderRouter
  participant L as LLM (Groq / Gemini)
  participant E as Executor
  participant T as Host tools
  participant D as Docker sandbox

  UI->>S: POST /api/sessions/:id/messages { content }
  S-->>UI: 202 { runId }
  Note over UI,S: UI already holds GET /api/sessions/:id/events (SSE)
  S->>R: start(sessionId, content)
  R->>P: stream(system prompt + history + codemode tool)
  P->>L: request (retries / fails over on transient errors)
  L-->>P: tool call codemode({ code })
  P-->>R: complete result (partial streams discarded)
  R->>R: dedupe by (run, toolCallId) and code hash
  R->>E: runCode(code, providers)
  loop each tool call in the program
    E->>T: { type: "tool-call", namespace, name, args }
    T->>D: docker run --network none --read-only ...
    D-->>T: stdout / stderr / exit code
    T-->>E: JSON result
  end
  E-->>R: { result, logs }
  R->>R: store execution, append tool message
  R->>P: stream(history + tool result)
  P->>L: request
  L-->>P: final answer (no tool calls)
  R-->>UI: run.completed (via event bus → SSE)
```

Each arrow that changes state also emits an event (`run.started`, `llm.request`, `provider.retry`, `provider.failover`, `assistant.delta`, `assistant.message`, `execution.started`, `tool.call`, `tool.result`, `execution.log`, `execution.output`, `execution.completed`, `execution.deduplicated`, `run.completed` / `run.failed` / `run.cancelled`). Text deltas are live-only; everything else is persisted.

### Data model

SQLite via `node:sqlite`, one file, `<DATA_DIR>/agentos.sqlite` (default `.data/`).

| Table | Key columns | Purpose |
|---|---|---|
| `sessions` | `id`, `title`, `updated_at` | A conversation and its workspace directory |
| `runs` | `id`, `session_id`, `status`, `provider`, `model`, `error` | One user message and everything it triggered |
| `messages` | `session_id`, `role`, `content`, `tool_calls`, `tool_call_id`, `provider`, `model` | Provider-neutral history replayed to whichever provider serves the next request |
| `executions` | `run_id`, `tool_call_id`, `code`, `code_hash`, `status`, `result`, `logs`, `executor` | Every program run; the basis for idempotency and the History tab |
| `events` | `id` (monotonic), `run_id`, `session_id`, `type`, `data` | The UI timeline; `id` is the SSE `Last-Event-ID` |

Session files live in `.data/workspaces/<session>/`, mounted at `/workspace` in the sandbox and listed as artifacts in the UI.

### Failure model

- **Provider errors** are normalized into a `ProviderError.kind`. The retry policy decides between *retry the same provider*, *fail over* and *fail*; see [Failover policy](#failover-policy-workersagentsrcproviders).
- **Exactly-once execution.** The router never executes code, so a retried or failed LLM call cannot run a program. Executions are unique per `(run, toolCallId)`, and after a provider switch a program whose normalized hash already completed in the run is reused (`execution.deduplicated`).
- **Program errors** (exceptions, tool failures, timeouts) come back to the model as `{ ok: false, error, logs }` so it can fix the code and retry, bounded by the step limit.
- **Interrupted runs.** `sanitizeHistory` gives any tool call without a result a synthetic "not executed" result, so the stored history stays valid for every provider.
- **Step limit.** After `LLM_MAX_AGENT_STEPS` tool steps the model gets one more call with tool use forbidden and must answer from what it has. Tool calls it still makes are recorded as `tool.rejected` and never run. If it gives no answer, the run fails with `STEP_LIMIT` and the last execution error.
- **Fake execution guard.** If the model pastes a program in its reply instead of calling the tool, the reply is discarded once and the model is told to run it.

### Security model

The program is untrusted, and so is anything it fetches.

| Layer | Boundary |
|---|---|
| Program context | Fresh V8 context; no `require` / `import` / `process` / `fetch`; string eval and Wasm off; only JSON strings cross; heap limit; `CODEMODE_TIMEOUT_MS` limits the program's own run time (time waiting on host tools such as installs is not counted) and `CODEMODE_MAX_WALL_MS` caps total wall time; either kills the worker or container |
| Host tools | Arguments validated against the tool's input schema; `fs` confined to the session workspace (no `..`, no symlink escape) |
| Sandbox containers | `--network none`, read-only root, `--cap-drop ALL`, `no-new-privileges`, non-root user, memory / CPU / PID limits, small tmpfs |
| Package installs | Allowlist only, validated names / versions, argv not shell, pip binary wheels only (`--only-binary=:all:`, no source builds), npm `--ignore-scripts`, network only during the install |
| `web.fetch` | Public http(s) only; private, loopback, link-local and metadata IPs blocked after DNS and after each redirect; 200 KB cap |
| Secrets | Provider keys live only in the agent process; the browser sees names, models, health |
| MCP servers | Server credentials (`env`, `headers`, `${VAR}` values) stay in the agent process; programs get typed stubs and JSON results only. Stdio servers get the MCP SDK's minimal default environment (`PATH`, `HOME`, `USER`, …) plus their own `env`, never the agent's LLM keys. The UI sees the command or URL as written (no query string, no header or env values). A server's tool descriptions and results are untrusted input, like any `web.fetch` result |

The `local` executor is a development adapter: `node:vm` is not a security boundary. Use `CODEMODE_EXECUTOR=docker` when the stronger boundary matters.

### Deployment

- **Local dev:** `./run.sh` (or `npm run dev`). Agent on `127.0.0.1:8787`, Vite on `:5173` proxying `/api`.
- **Docker Compose:** nginx serves the web build and proxies `/api` to the agent container. The agent starts sandbox containers as siblings through the host Docker socket (`WORKSPACE_HOST_DIR` maps the data dir for mounts).
- **Cloudflare Workers (future):** the agent and executors already speak `@cloudflare/codemode`'s `Executor` interface. Moving means adding a `DynamicWorkerExecutor` in `codemode/execution-router.ts` and replacing SQLite / Docker with Workers equivalents; the agent loop does not change.

### Design decisions

| Decision | Why | Trade-off |
|---|---|---|
| One `codemode` tool instead of many tools | Fewer round trips, real control flow, smaller context | A program failure is coarser than a single tool failure; the model must fix and rerun |
| Own provider layer instead of an AI SDK wrapper | Precise error classification, failover mid-run, Gemini thought signatures | More adapter code to maintain |
| Provider-neutral history in SQLite | Any provider can continue any conversation | Foreign tool calls are replayed to Gemini as transcripts, not native calls |
| Execute only after a full provider response | Makes "never run twice" provable | No speculative execution while streaming |
| Two executors behind one interface | Fast local dev; container isolation when needed; Workers later | `local` is not a hard boundary |
| SSE with persisted events | Simple, reload-safe, replayable | One-way; actions use REST |
| MCP tools as a typed namespace, not LLM tools | Same Code Mode benefits for any MCP server; credentials never enter the program | The model only learns a server's tools from its types; a server with hundreds of tools makes a long tool description |

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
| Empty completion: no text and no tool call (e.g. a reasoning model that used its whole output on reasoning) | yes, bounded | yes |
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
| `local` (default) | **Development adapter.** A fresh V8 context in a worker thread | Empty env, no `require` / `process` / `fetch`, string-eval and Wasm disabled, only JSON strings cross the boundary, heap limit, program-time limit plus wall-clock cap (thread terminated). `node:vm` is not a security boundary. |
| `docker` | The same runtime in a throwaway container | `--network none`, read-only root fs, `--cap-drop ALL`, no-new-privileges, memory / CPU / PID limits, program-time limit plus wall-clock cap |

Neither is Cloudflare's managed **`DynamicWorkerExecutor`**. That one requires the Workers runtime with a Worker Loader binding (Dynamic Workers, which may need a paid plan), so AgentOS does not use it. Moving to Workers later means swapping `codemode/execution-router.ts`, not the agent.

## Tools available to programs

| Namespace | Tools |
|---|---|
| `fs` | `listFiles`, `readFile`, `writeFile`, `deleteFile`, all confined to the session workspace (path traversal and symlink escapes are rejected) |
| `sandbox` | `runPython`, `runNode`, `runShell` (Docker, no network, workspace mounted at `/workspace`), `installPackage` (pip/npm **allowlist** only; names and versions validated; argv only, no shell; network enabled only for the install; npm `--ignore-scripts`), `listAllowedPackages` |
| `web` | `fetch`: public http(s) only; private, loopback, link-local and metadata addresses are blocked, including after redirects; 200 KB cap |
| `codemode` | `searchTools`: tool discovery across built-in and MCP tools (MCP hits include the server and real MCP tool name) |
| `<server>` | One namespace per connected MCP server, e.g. `everything.get_sum(...)`; see [MCP servers](#mcp-servers) |

Files in the workspace appear as downloadable artifacts in the UI.

## MCP servers

AgentOS follows the [Code Mode post](https://blog.cloudflare.com/code-mode/): MCP tools are **not** given to the model as tools. The agent connects to each server, converts its tools into a TypeScript API, and programs call that API. The model still sees exactly one tool, `codemode`, and the server's credentials stay in the agent, which plays the role of the post's "bindings".

```
mcp.json ──▶ MCP client (@modelcontextprotocol/sdk) ──tools/list──▶ McpConnector (@cloudflare/codemode)
                                                                       │ sanitize names, unwrap results
                                                                       ▼
                       NamespaceSpec "everything" ──namespaceTypes()──▶ declare const everything: { get_sum(...); ... }
                                                                       │  (appended to the codemode tool description)
program: await everything.get_sum({ a: 1, b: 2 }) ──JSON──▶ host ──tools/call "get-sum"──▶ server
```

**Configure.** Point `MCP_CONFIG_FILE` at a JSON file (relative paths resolve from the repo root), or put the same JSON in `MCP_SERVERS`. Entries in `MCP_SERVERS` override file entries with the same name. The format is the usual `mcpServers` map:

```json
{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything@2.0.0"]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "namespace": "docs",
      "timeoutMs": 30000
    }
  }
}
```

| Field | Transport | Meaning |
|---|---|---|
| `command`, `args`, `env`, `cwd` | stdio | Process to start. It gets the SDK's minimal default environment plus `env` |
| `url`, `headers` | Streamable HTTP | Endpoint and request headers (e.g. auth) |
| `namespace` | both | Name used in programs. Default: the server name with `-` / `.` turned into `_`. Built-in names (`fs`, `sandbox`, `web`, `codemode`) and JavaScript globals are refused |
| `description` | both | Shown in the generated types and the UI. Default: the first paragraph of the server's `instructions` |
| `enabled` | both | `false` keeps the entry but does not connect |
| `timeoutMs` | both | Per-call timeout (default `MCP_CALL_TIMEOUT_MS`) |

| Env var | Default | Meaning |
|---|---|---|
| `MCP_CONFIG_FILE` | unset | Path to the JSON config (`.env.example` sets `mcp.json`) |
| `MCP_SERVERS` | unset | Inline JSON in the same format |
| `MCP_CONNECT_TIMEOUT_MS` | `30000` | Start / reach the server, handshake and first `tools/list` |
| `MCP_CALL_TIMEOUT_MS` | `60000` | Default limit for one tool call |
| `MCP_RECONNECT_MAX_MS` | `60000` | Longest wait between reconnect attempts |

`${VAR}` in `args`, `env`, `url` and `headers` is filled from the agent's environment (`.env`), so the config file holds no secrets. If a variable is unset, that server is reported as failed and the others still connect. A malformed file stops startup with a clear error.

**Types.** Each tool's `inputSchema` becomes the input type and its `outputSchema`, when present, the return type, through the same `generateTypesFromJsonSchema` pipeline as the built-in tools. Tool names that are not JavaScript identifiers are sanitized (`get-sum` → `get_sum`, `files.list` → `files_list`, collisions get `_2`), and the real MCP name is kept for the call. Tools without an output schema return `McpToolResult`: the text output, JSON-parsed when it is JSON, or the raw `{ content: [...] }` when it contains images, audio or resources.

**Calls.** `structuredContent` is returned as is. `isError` results and transport errors (timeouts, a dropped connection) are thrown inside the program as `Error("<server>/<mcp tool>: <message>")`, so the program can catch them. Arguments are checked against the input schema before the call. Works the same with `CODEMODE_EXECUTOR=local` and `docker`.

**Lifecycle.** Servers connect in the background at startup (`MCP_CONNECT_TIMEOUT_MS` per attempt). A failed or dropped server is retried with exponential backoff up to `MCP_RECONNECT_MAX_MS`; until it is back, new runs do not see its namespace. A run snapshots the namespaces when it starts, so a server changing mid-run cannot change the tool definition between two LLM calls. The first run after startup waits for servers that are still connecting. `tools/list_changed` notifications update the namespace for later runs.

**Where it shows.** `GET /api/status` → `mcp.servers` (state, error, tool count, server name and version, next retry). `GET /api/tools` lists MCP namespaces with `source: "mcp"`, their generated TypeScript and each tool's `mcpName`. The sidebar's tool catalog has an **MCP servers** group with a health dot per server and the error inline when one is down. The How it works page has an MCP walkthrough with real payloads from `server-everything`.

## UI

- **How it works** (`/#how-it-works`, linked from the header and the empty state): a scripted, step-by-step replay of one run, with a failover toggle. "Try it yourself" opens the workspace with the demo prompt filled in.
- **Left sidebar:** sessions, tool catalog (built-in namespaces and MCP servers with a health dot), executor and sandbox status.
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

`workers/agent/test/mcp/mcp.test.ts` runs a test MCP server built with the SDK in-process, as a stdio process and over Streamable HTTP on `127.0.0.1`. It covers config parsing and `${VAR}` filling, the generated TypeScript and name mapping, calls from programs (structured, text, JSON text), `isError` and timeouts as thrown errors, a full agent run through the mock LLM, a server that is down at startup, reconnects, `tools/list_changed`, the Docker executor, and that programs, `/api/status` and `/api/tools` never see MCP credentials.

The other suites cover error classification, retry and health, structured output, Gemini history conversion, executor escape attempts and limits, Docker sandbox isolation (network, read-only fs, timeout), workspace path safety and the package allowlist.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Provider health, executor, sandbox, MCP servers |
| GET | `/api/tools` | Namespaces (built-in and MCP) with generated TypeScript, plus `mcpServers` |
| GET/POST/DELETE | `/api/sessions[/:id]` | Sessions (GET includes messages, runs, executions) |
| POST | `/api/sessions/:id/messages` | Start a run → `{ runId }` |
| POST | `/api/runs/:id/cancel` | Cancel a run |
| GET | `/api/sessions/:id/events` | SSE: replays persisted events, then live; supports `Last-Event-ID` |
| GET | `/api/executions[/:id]` | Execution history |
| GET | `/api/sessions/:id/files[/content\|/download]` | Workspace artifacts |
