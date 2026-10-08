/**
 * agent.ts — Code Mode Agent Loop
 *
 * Implements the core "Code Mode" pattern from Cloudflare's blog post:
 * Instead of exposing N individual tools to the LLM, we expose a single
 * "execute code" tool. The LLM writes TypeScript that calls a typed API,
 * and that code runs in a sandboxed Dynamic Worker.
 *
 * Flow:
 * 1. On startup, fetch tool schemas from the configured MCP server
 * 2. Convert schemas to TypeScript declarations and ToolDescriptors
 * 3. Use @cloudflare/codemode's createCodeTool to wrap them into one "codemode" tool
 * 4. Pass user message + system prompt (with API types) to the LLM via streamText
 * 5. LLM writes code → DynamicWorkerExecutor runs it → result returned to LLM
 * 6. LLM uses the result to respond to the user (or writes more code)
 *
 * Why this is better than raw MCP tool calls:
 * - Up to 80% fewer tokens (the LLM can loop/filter in code, not in prompts)
 * - Better results (procedural logic > chain-of-thought for data processing)
 * - Single round-trip for multi-tool workflows
 */

import { streamText, isStepCount } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createCodeTool, aiTools } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { ToolDescriptors } from "@cloudflare/codemode/ai";
import { z } from "zod";

import {
  fetchMcpSession,
  mcpToolsToGenerated,
  generateApiDeclaration,
  type GeneratedTool,
} from "./mcp-to-ts";

/** Environment bindings — matches wrangler.toml */
export interface Env {
  LOADER: unknown; // Worker Loader binding (Dynamic Workers API)
  OPENAI_API_KEY: string;
  MCP_SERVER_URL: string;
  AUTH_SESSIONS: DurableObjectNamespace;
}

/**
 * Build the system prompt that teaches the LLM about the Code Mode pattern.
 *
 * The prompt includes the full TypeScript API declaration generated from
 * MCP tool schemas, so the LLM knows exactly what methods are available.
 */
function buildSystemPrompt(apiDeclaration: string): string {
  return `You are a helpful assistant that uses Code Mode to accomplish tasks.

## How Code Mode Works

Instead of calling tools individually, you write JavaScript code that orchestrates
calls to a typed API. Your code runs in a sandboxed environment — the only way to
interact with external services is through the \`codemode\` object.

When you need to perform actions, use the \`codemode\` tool and write JavaScript code.
The \`codemode\` object is available as a global in your sandbox.

## Available API

The following TypeScript declarations describe the API available to your code:

\`\`\`typescript
${apiDeclaration}
\`\`\`

## Guidelines

1. **Write async code** — All codemode methods return Promises. Use \`await\`.
2. **Process data in code** — Filter, map, and transform in code. This saves tokens.
3. **Combine multiple calls** — Call multiple API methods in one snippet. Much more
   efficient than separate tool invocations.
4. **Return results** — The last expression in your code is the return value.
5. **Use console.log** — Output is captured and returned to you for debugging.
6. **Handle errors** — Use try/catch for operations that might fail.
7. **No network access** — \`fetch()\` is blocked. Use the \`codemode\` API only.
8. **Report tool failures clearly** — If an MCP call fails, tell the user the tool's
   exact error and what to try next. Do not claim you fetched data or say you are
   troubleshooting further unless another tool call succeeds.

## Example

If asked "search for information about Workers AI", write:

\`\`\`javascript
const results = await codemode.search({ query: "Workers AI" });
console.log("Found", results.length, "results");
results
\`\`\`
`;
}

/**
 * Convert GeneratedTool definitions into the ToolDescriptors format expected
 * by @cloudflare/codemode. Each entry has a description, an inputSchema (Zod),
 * and an execute function that proxies the call to the MCP server.
 *
 * We use ToolDescriptors (not AI SDK tool()) because it maps directly to the
 * codemode library's native format and avoids inference issues with dynamic schemas.
 */
function buildToolDescriptors(
  generatedTools: GeneratedTool[],
  mcpServerUrl: string,
  sessionId: string | null,
  accessToken: string
): ToolDescriptors {
  const descriptors: ToolDescriptors = {};

  for (const gt of generatedTools) {
    descriptors[gt.name] = {
      description: gt.description,
      inputSchema: gt.parameters as z.ZodType,
      execute: async (args: unknown) => {
        // Forward the tool call to the MCP server via JSON-RPC
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
        };
        if (sessionId) {
          headers["mcp-session-id"] = sessionId;
        }

        const response = await fetch(mcpServerUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name: gt.name, arguments: args },
          }),
        });

        if (!response.ok) {
          throw new Error(
            `MCP tools/call failed for "${gt.name}": ${response.status} ${response.statusText}`
          );
        }

        // Parse response (may be JSON or SSE stream)
        const contentType = response.headers.get("content-type") ?? "";
        let rpcResult: Record<string, unknown> | null = null;

        if (contentType.includes("text/event-stream")) {
          const text = await response.text();
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data && data !== "[DONE]") {
                rpcResult = JSON.parse(data) as Record<string, unknown>;
                break;
              }
            }
          }
        } else {
          rpcResult = (await response.json()) as Record<string, unknown>;
        }

        // Extract the tool result content from the MCP response envelope
        const rpcError = rpcResult?.error as Record<string, unknown> | undefined;
        if (rpcError) {
          const errorMessage = typeof rpcError.message === "string"
            ? rpcError.message
            : JSON.stringify(rpcError);
          throw new Error(`MCP tools/call error for "${gt.name}": ${errorMessage}`);
        }

        const toolResult = rpcResult?.result as Record<string, unknown> | undefined;
        if (toolResult?.content && Array.isArray(toolResult.content)) {
          // MCP returns content as an array of typed content blocks (text, image, etc.)
          const content = (toolResult.content as Array<Record<string, unknown>>)
            .map((block) => block.text ?? JSON.stringify(block))
            .join("\n");
          if (toolResult.isError === true) {
            throw new Error(`MCP tool "${gt.name}" failed: ${content || "The server returned an unspecified tool error."}`);
          }
          return content;
        }

        if (toolResult?.isError === true) {
          throw new Error(`MCP tool "${gt.name}" failed: ${JSON.stringify(toolResult)}`);
        }

        return toolResult ?? rpcResult;
      },
    };
  }

  return descriptors;
}

/**
 * Run the Code Mode agent loop.
 *
 * Takes a user message, connects to the MCP server, generates the typed API,
 * and streams the LLM response back as a text stream.
 *
 * @param userMessage - The user's input message
 * @param env - Worker environment bindings
 * @returns A streaming Response
 */
export async function runAgent(userMessage: string, env: Env, accessToken: string): Promise<Response> {
  // Step 1: Connect to the MCP server and fetch tool schemas
  console.log(`Connecting to MCP server: ${env.MCP_SERVER_URL}`);

  let generatedTools: GeneratedTool[];
  let sessionId: string | null = null;

  try {
    // Keep the tools/list session ID for the later tools/call requests.
    // Creating a second session here caused calls to use a stale session.
    const mcpSession = await fetchMcpSession(env.MCP_SERVER_URL, accessToken);
    sessionId = mcpSession.sessionId;
    generatedTools = mcpToolsToGenerated(mcpSession.tools);
    console.log(`Loaded ${generatedTools.length} tools from MCP server`);
  } catch (error) {
    console.error("Failed to connect to MCP server:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to connect to MCP server",
        details: error instanceof Error ? error.message : String(error),
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 2: Generate TypeScript API declaration for injection into the system prompt
  const apiDeclaration = generateApiDeclaration(generatedTools);
  const systemPrompt = buildSystemPrompt(apiDeclaration);

  // Step 3: Build ToolDescriptors and wrap them with aiTools() for the codemode library
  const toolDescriptors = buildToolDescriptors(generatedTools, env.MCP_SERVER_URL, sessionId, accessToken);
  const toolProvider = aiTools(toolDescriptors);

  // Step 4: Create the sandbox executor
  // Each invocation of the codemode tool spins up a fresh Dynamic Worker isolate.
  // - globalOutbound: null blocks all fetch() inside the sandbox
  // - Tools are dispatched back to this Worker via Workers RPC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LOADER is opaque from wrangler binding types
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER as any,
    timeout: 30_000,
    globalOutbound: null,
  });

  // Step 5: Create the single "codemode" tool that the LLM calls
  // createCodeTool generates TypeScript types from the tool descriptors and
  // puts them in the tool description, so the LLM sees a typed API surface.
  const codemodeTool = createCodeTool({
    // Pass as a single-element array — ToolProvider[] overload of CreateCodeToolOptions
    tools: [toolProvider],
    executor,
  });

  // Step 6: Call the LLM via Vercel AI SDK streamText
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });

  const result = streamText({
    model: openai("gpt-4o"),
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: { codemode: codemodeTool },
    stopWhen: isStepCount(5),
    onError: (error) => console.error("streamText error:", error),
  });

  return result.toTextStreamResponse();
}
