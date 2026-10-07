/**
 * index.ts — Worker Entrypoint
 *
 * Routes incoming HTTP requests:
 * - GET  /             → Serves the chat frontend (src/public/index.html)
 * - POST /api/chat     → Run the Code Mode agent with a user message (streaming)
 * - GET  /api/tools    → List available MCP tools and generated TypeScript declarations
 *
 * This Worker holds MCP credentials. API keys never enter generated code —
 * all MCP calls from the Dynamic Worker sandbox route back through here via RPC.
 */

// Wrangler inlines static assets referenced with the `Text` module type.
// See wrangler.toml [rules] section.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- HTML module type is resolved by wrangler at bundle time
import FRONTEND_HTML from "./public/index.html";


import { runAgent, type Env } from "./agent";
import { fetchMcpTools, mcpToolsToGenerated, generateApiDeclaration } from "./mcp-to-ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── CORS headers for frontend consumption ────────────────────────
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      switch (url.pathname) {
        // ── POST /api/chat — Main agent endpoint ───────────────────
        case "/api/chat": {
          if (request.method !== "POST") {
            return jsonResponse(
              { error: "Method not allowed. Use POST." },
              405,
              corsHeaders
            );
          }

          const body = await request.json<{ message?: string }>();
          const userMessage = body?.message;

          if (!userMessage || typeof userMessage !== "string") {
            return jsonResponse(
              { error: "Missing 'message' field in request body" },
              400,
              corsHeaders
            );
          }

          if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === "sk-your-key-here") {
            return jsonResponse(
              {
                error: "OPENAI_API_KEY not configured",
                hint: "Set it in .dev.vars for local dev, or via `wrangler secret put OPENAI_API_KEY` for production",
              },
              500,
              corsHeaders
            );
          }

          // Run the agent and return the streaming response
          const response = await runAgent(userMessage, env);

          // Add CORS headers to the streaming response
          const headers = new Headers(response.headers);
          for (const [key, value] of Object.entries(corsHeaders)) {
            headers.set(key, value);
          }

          return new Response(response.body, {
            status: response.status,
            headers,
          });
        }

        // ── GET /api/tools — Debug endpoint to inspect MCP tools ───
        case "/api/tools": {
          if (request.method !== "GET") {
            return jsonResponse(
              { error: "Method not allowed. Use GET." },
              405,
              corsHeaders
            );
          }

          const mcpTools = await fetchMcpTools(env.MCP_SERVER_URL);
          const generated = mcpToolsToGenerated(mcpTools);
          const apiDeclaration = generateApiDeclaration(generated);

          return jsonResponse(
            {
              mcpServer: env.MCP_SERVER_URL,
              toolCount: generated.length,
              tools: generated.map((t) => ({
                name: t.name,
                description: t.description,
                tsSignature: t.tsSignature,
              })),
              apiDeclaration,
            },
            200,
            corsHeaders
          );
        }

        // ── GET / — Serve the chat frontend ───────────────────────
        case "/": {
          if (request.method !== "GET") {
            return jsonResponse({ error: "Method not allowed. Use GET." }, 405, corsHeaders);
          }
          return new Response(FRONTEND_HTML as string, {
            headers: { 
              "Content-Type": "text/html;charset=UTF-8",
              "Cache-Control": "no-cache, no-store, must-revalidate"
            },
          });
        }

        default:
          return jsonResponse({ error: "Not found" }, 404, corsHeaders);
      }
    } catch (error) {
      console.error("Unhandled error:", error);
      return jsonResponse(
        {
          error: "Internal server error",
          details: error instanceof Error ? error.message : String(error),
        },
        500,
        corsHeaders
      );
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Helper to build a JSON response with consistent headers.
 */
function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
