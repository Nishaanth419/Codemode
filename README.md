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

# 2. Set your OpenAI API key in .dev.vars
echo "OPENAI_API_KEY=sk-your-actual-key" > .dev.vars

# 3. Start the dev server
npm run dev
```

The server starts at `http://localhost:8787`. Open it in a browser and choose **Connect INDmoney**. Sign in and approve the requested read-only access on INDmoney's page; the app never asks for your OTP or MPIN.

The OAuth authorization code flow uses PKCE. Tokens are kept in a Durable Object session and refreshed when possible. The browser receives only an HTTP-only session cookie.

After connecting, ask a question in the chat. Use **Disconnect** to revoke the INDmoney access token and clear the local session.

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

2. For OAuth protected services, implement their OAuth discovery and token flow before connecting. The included OAuth routes target INDmoney's published MCP authorization metadata.

3. Once configured, the agent automatically:
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

The app is served by one Cloudflare Worker: the same URL hosts the website, API, and installable PWA. No separate frontend hosting service is needed.

> **Plan requirement:** This agent uses Cloudflare Dynamic Workers to run generated code. Dynamic Workers require Cloudflare's Workers Paid plan, which currently starts at $5/month; additional usage may be billed. See [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/) before enabling billing.

```bash
# Authenticate Wrangler with your Cloudflare account
npx wrangler login

# Store the OpenAI key as a Worker secret
wrangler secret put OPENAI_API_KEY

# Publish the website and API
npm run deploy
```

Wrangler prints the public `workers.dev` URL after deployment. Open that URL and choose **Connect INDmoney** to authorize the account. OAuth callback URLs are derived from the URL being used, so connect using the final public HTTPS hostname. You can attach a custom domain later under the Worker’s Domains & Routes settings.

### Install the app

The site is an installable Progressive Web App (PWA). On a supported browser, open the deployed HTTPS site and choose **Install app** (Chrome/Edge) or **Add to Home Screen** (iOS Safari). The cached shell can open offline; sign-in, portfolio data, and AI responses still require an internet connection.

The PWA and website share the same Worker deployment and URL. Publishing native App Store or Google Play packages would require a separate native app project and store accounts.

The deployment needs the `AuthSessionStore` Durable Object binding and migration declared in `wrangler.toml`. OAuth callback URLs use the current application origin, so use the deployed HTTPS URL when connecting in production.

## References

- [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) — Cloudflare blog post
- [Dynamic Workers docs](https://developers.cloudflare.com/dynamic-workers/) — API reference
- [Dynamic Workers Code Mode example](https://developers.cloudflare.com/dynamic-workers/examples/codemode/) — Official example
- [`@cloudflare/codemode` npm](https://www.npmjs.com/package/@cloudflare/codemode) — The codemode library
- [Vercel AI SDK](https://sdk.vercel.ai/docs) — LLM integration
