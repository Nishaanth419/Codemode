# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read this before changing code. The system design lives in [README.md](README.md#system-design); the guided demo is the **How it works** page in the web app (`/#how-it-works`).

## What this is

AgentOS is a Code Mode agent. The LLM gets **one tool**, `codemode({ code })`, and writes a single JavaScript program that calls typed host tools (`fs`, `sandbox`, `web`, `codemode`). The program runs in an isolated executor; Python / Node.js / bash run in a Docker sandbox. LLM calls go through a provider router with Groq → Gemini → (Ollama) failover.

## Repository map

```
workers/agent/            Node backend (Express 5, TypeScript, node:sqlite)
  src/index.ts            entry: loads config, builds the app, listens on PORT
  src/app.ts              composition root: db, providers, executors, tools, runner
  src/server.ts           REST + SSE routes
  src/config.ts           every env var, validated with zod
  src/agent/              agent loop (agent-runner.ts), system prompt, event bus
  src/providers/          provider interface, Groq/Gemini/Ollama adapters, errors, retry, router, health
  src/codemode/           codemode tool definition + type generation, executors, executor router
  src/tools/registry.ts   host tools exposed to programs, arg validation, call observer
  src/sandbox/            Docker runner, workspace path safety, package allowlist
  src/db/database.ts      SQLite schema and queries
  src/shims/              maps `cloudflare:workers` to a local shim so @cloudflare/codemode loads on Node
  test/                   vitest suites; test/helpers has the mock LLM and harness
apps/web/                 React 19 + Vite + Tailwind v4 + shadcn-style UI
  src/main.tsx            hash router: `#how-it-works` → demo page, otherwise the workspace
  src/App.tsx             workspace shell (sidebar, chat, inspector)
  src/components/how-it-works.tsx   scripted, offline walkthrough of one run
  src/hooks/use-agent.ts  status polling + SSE session stream
  src/lib/timeline.ts     reducer that turns events into chat items (tested)
sandbox/
  Dockerfile              agentos-sandbox image (Python 3, Node 24, bash)
  codemode-runtime.mjs    the program runtime used by BOTH executors
```

## Commands

Run from the repository root.

| Task | Command |
|---|---|
| Install | `npm install` |
| Build sandbox image | `npm run sandbox:build` |
| Dev (agent :8787 + web :5173) | `npm run dev` |
| One side only | `npm run dev:agent` / `npm run dev:web` |
| All tests (no network) | `npm test` |
| Real-provider smoke tests | `npm run test:smoke` (only runs providers that have keys / are reachable) |
| Typecheck | `npm run typecheck` |
| Full stack in Docker | `docker compose up --build` (UI on :8080, or set `WEB_PORT`) |

Before saying a change is done: `npm run typecheck && npm test`. If you touched the UI, open it and look.

## Invariants: do not break these

1. **One tool.** The LLM only ever sees `codemode`. New capabilities are new functions inside a namespace in `tools/registry.ts`, never new top-level LLM tools.
2. **The router never runs code.** `providers/` only talks to models. Execution happens in `agent-runner.ts` after a provider call has fully succeeded. Partially streamed tool calls are discarded.
3. **A program never runs twice.** Executions are keyed by `(run_id, tool_call_id)` and deduplicated by code hash after a provider switch (`handleToolCall`). Keep both checks if you touch that code.
4. **No silent fallback on configuration errors.** `auth`, `bad_request`, `model_not_found` and `context_length` stop the run with a visible error. Only transient kinds (`rate_limit`, `quota_exhausted`, 5xx, timeout, network, malformed tool call) fail over. See the table in `providers/errors.ts`.
5. **Same agent on every provider.** Every provider gets the identical system prompt (`agent/prompts.ts`), the full persisted history and the same tool definition. Provider-specific wire details (Gemini thought signatures, OpenAI-style tool calls) stay inside the adapters.
6. **Keys stay on the server.** The browser only sees provider names, models and health. No OpenAI or Anthropic credentials are used anywhere.
7. **Isolation is not optional.** The program context has no `require`, `import`, `process`, `fetch`, `eval` or WebAssembly, and only JSON strings cross the boundary. Sandbox containers keep `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges` and resource limits. `web.fetch` blocks private, loopback, link-local and metadata addresses, including after redirects. `fs.*` rejects path traversal and symlink escapes.
8. **Package installs are allowlisted and binary-only.** `SANDBOX_ALLOWED_PACKAGES`; argv only, no shell; pip `--only-binary=:all:` (the sandbox is Debian/glibc so manylinux wheels exist; source builds cannot work there); npm with `--ignore-scripts`.
9. **Events are the contract with the UI.** Persisted events in SQLite are replayed over SSE with `Last-Event-ID`. If you add or rename an event type, update `apps/web/src/lib/timeline.ts` and its test.
10. **The final step never executes tools.** On the last allowed step the runner sends `toolChoice: "none"` and drops any tool calls the model still returns. Timeouts measure the program's own run time; host tool waits are excluded, bounded by `CODEMODE_MAX_WALL_MS`.

## Common changes

**Add a host tool.** Add an entry to the right namespace in `createToolNamespaces` (`workers/agent/src/tools/registry.ts`) with `description`, `inputSchema`, `outputSchema` and `execute(args, ctx)`. Types for the prompt are generated from the schemas automatically. Write precise descriptions: they are the model's only documentation. Add a test.

**Add an LLM provider.** Implement `LLMProvider` from `providers/provider-interface.ts` (OpenAI-compatible APIs can extend `openai-compatible.ts`), map its failures to a `ProviderErrorKind` in `errors.ts`, register it in `providers/index.ts`, add config to `config.ts` and `.env.example`, and cover it in `test/providers/`.

**Change the executor.** Both executors implement `@cloudflare/codemode`'s `Executor` and share `sandbox/codemode-runtime.mjs`. Choose between them in `codemode/execution-router.ts`. A Cloudflare Workers deployment would add a `DynamicWorkerExecutor` there.

**Change the system prompt.** `agent/prompts.ts`. Keep rule 0 (always execute through the tool, never paste a program in the reply). `looksLikeUnexecutedProgram` in `agent-runner.ts` nudges the model once if it does.

**Change the How it works page.** It is fully scripted (no backend calls) so it works without API keys. If you change the real flow, event names, limits or payload shapes, update the `STEPS` in `how-it-works.tsx` to match. Every payload on that page should be something the code actually produces.

## Conventions

- Node ≥ 22.13 (`node:sqlite`), ESM everywhere. Backend imports use the `.js` suffix on relative paths.
- The backend starts with `tsx --import ./src/shims/register.ts`. Without the shim, `@cloudflare/codemode` fails to import `cloudflare:workers`.
- Validate external input with zod (`config.ts`, request bodies in `server.ts`).
- Tests never hit the network. Use `test/helpers/mock-llm.ts` and the injected `fetch`. Docker-dependent tests skip when Docker is unavailable.
- UI: use the design tokens in `apps/web/src/index.css` (obsidian / lime / paper), the primitives in `components/ui/`, `lucide-react` icons and the `@/` import alias. Layout must work from 375 px up.
- Keep comments for the *why*. File headers in this repo explain each module's role; keep them accurate.

## Local environment notes

- Without Groq / Gemini keys you can still run everything with `OLLAMA_ENABLED=true` and a local Ollama (`gpt-oss:20b`).
- Data (SQLite db, session workspaces) lives in `.data/` and is gitignored.
- The agent container controls the host Docker daemon through `/var/run/docker.sock` to start sibling sandbox containers. That is fine locally and not acceptable for multi-tenant hosting.
