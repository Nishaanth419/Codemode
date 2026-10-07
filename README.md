# Code Mode Agent

> Instead of exposing MCP tools directly to the LLM, convert them into a typed TypeScript API, have the LLM write code that calls that API, and execute it in a sandboxed Worker.

Inspired by [Cloudflare's Code Mode blog post](https://blog.cloudflare.com/code-mode/). This project implements the full pattern using Cloudflare Workers, Dynamic Workers, and the `@cloudflare/codemode` library.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     User Request                             │
│                    POST /api/chat                             │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Main Worker (src/index.ts)                      │
│                                                              │
│  1. Fetch MCP tool schemas (src/mcp-to-ts.ts)               │
│  2. Generate TypeScript declarations + Zod schemas           │
│  3. Build system prompt with typed API                       │
│  4. Call LLM with single "codemode" tool                    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │           LLM writes JavaScript code                    │  │
│  │     const results = await codemode.search(...)          │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           ▼                                  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │         Dynamic Worker Sandbox                          │  │
│  │  • No network access (globalOutbound: null)             │  │
│  │  • codemode proxy routes to real tool impls             │  │
│  │  • Console output captured                              │  │
│  │  • 30s timeout per execution                            │  │
│  └────────────────────────┬───────────────────────────────┘  │
│                           ▼                                  │
│  Result → LLM → User response (streamed)                    │
└─────────────────────────────────────────────────────────────┘
```

## Why Code Mode?

Traditional MCP usage exposes each tool as a separate function call. The LLM calls them one at a time, passing results through context. This is:
- **Expensive**: Each tool call round-trip costs tokens
- **Slow**: Sequential tool calls can't be parallelized
- **Noisy**: Tool results bloat the context window

Code Mode flips this: the LLM writes a single code snippet that orchestrates multiple tool calls, processes data locally, and returns a focused result. Up to **80% fewer tokens** and better results.

## Setup

### Prerequisites

- Node.js 18+
- A Cloudflare account (for production deployment)
- An OpenAI API key

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Set your OpenAI API key in .env
echo "OPENAI_API_KEY=sk-your-actual-key" > .env

# 3. Start the dev server
npm run dev
```

The server starts at `http://localhost:8787`.

### Test it

```bash
# Check available MCP tools
curl http://localhost:8787/api/tools | jq .

# Send a message to the agent
curl -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What tools are available in the Cloudflare Agents SDK?"}'
```

## Project Structure

```
├── src/
│   ├── index.ts          # Worker entrypoint — routes HTTP requests
│   ├── agent.ts          # Code Mode agent loop (LLM + codemode tool)
│   ├── mcp-to-ts.ts      # MCP schema fetcher + TypeScript codegen
│   └── sandbox-worker.ts # Dynamic Worker sandbox configuration
├── wrangler.toml         # Cloudflare Workers config with Worker Loader binding
├── .env                  # Local dev secrets (not committed)
├── tsconfig.json         # TypeScript configuration
└── package.json          # Dependencies and scripts
```

### Key Files

| File | Purpose |
|------|---------|
| [`src/mcp-to-ts.ts`](src/mcp-to-ts.ts) | Connects to MCP server via Streamable HTTP, fetches tool schemas, converts JSON Schema → Zod schemas + TypeScript declarations |
| [`src/agent.ts`](src/agent.ts) | The agent loop: builds system prompt with generated API types, creates `codemode` tool via `@cloudflare/codemode`, streams LLM response |
| [`src/sandbox-worker.ts`](src/sandbox-worker.ts) | Configures the `DynamicWorkerExecutor` with no network access and 30s timeout |
| [`src/index.ts`](src/index.ts) | HTTP routing: `/api/chat` for the agent, `/api/tools` for debugging |

## Adding a New MCP Server

1. **Change the server URL** in `wrangler.toml`:
   ```toml
   [vars]
   MCP_SERVER_URL = "https://your-mcp-server.example.com/mcp"
   ```

2. **That's it!** The agent automatically:
   - Connects to the new server on each request
   - Fetches tool schemas via `tools/list`
   - Generates TypeScript declarations
   - Updates the system prompt

For multiple MCP servers, you'd extend the code to accept an array of URLs and merge the tool schemas. The `mcp-to-ts.ts` module is designed to be composable.

## How It Works Under the Hood

### 1. MCP → TypeScript Codegen (`mcp-to-ts.ts`)

```
MCP Server (tools/list) → JSON Schema → Zod Schema + TypeScript Declarations
```

For each MCP tool, we generate:
- A **Zod schema** for runtime validation of tool parameters
- A **TypeScript function signature** (e.g., `search(query: string): Promise<unknown>`)
- A **JSDoc comment block** with parameter descriptions

### 2. Code Mode Tool (`agent.ts`)

The `@cloudflare/codemode` library's `createCodeTool()` takes our generated tools and wraps them into a single AI SDK `tool()` called `codemode`. The tool's description includes the full TypeScript API surface, so the LLM knows exactly what's available.

### 3. Sandboxed Execution (`sandbox-worker.ts`)

When the LLM writes code, `DynamicWorkerExecutor` spins up a fresh Dynamic Worker:
- **No `fetch()`** — `globalOutbound: null` blocks all network access
- **Typed proxy** — A `codemode` object routes method calls back to real tool implementations via Workers RPC
- **Captured output** — `console.log()` calls are captured and returned
- **Fresh isolate** — Each execution gets a clean V8 isolate, no state leaks

## Deployment

```bash
# Set the API key secret
wrangler secret put OPENAI_API_KEY

# Deploy to Cloudflare
npm run deploy
```

## References

- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) — Cloudflare blog post
- [Dynamic Workers docs](https://developers.cloudflare.com/dynamic-workers/) — API reference
- [Dynamic Workers Code Mode example](https://developers.cloudflare.com/dynamic-workers/examples/codemode/) — Official example
- [`@cloudflare/codemode` npm](https://www.npmjs.com/package/@cloudflare/codemode) — The codemode library
- [Vercel AI SDK](https://sdk.vercel.ai/docs) — LLM integration
