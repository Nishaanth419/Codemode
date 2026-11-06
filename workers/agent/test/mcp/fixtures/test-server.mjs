// Test MCP server built with the official SDK. No network: tests use it in-process
// (InMemoryTransport), over stdio (`node test-server.mjs`), or over Streamable HTTP on
// 127.0.0.1 (see startHttpTestServer).
import http from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export function createTestServer() {
  const server = new McpServer({ name: "agentos-test-server", version: "1.2.3" }, { instructions: "Weather and arithmetic for AgentOS tests." });

  // Hyphenated name + output schema → structuredContent.
  server.registerTool(
    "get-forecast",
    {
      description: "Get the forecast for a city",
      inputSchema: { city: z.string().describe("City name"), days: z.number().int().optional() },
      outputSchema: { city: z.string(), tempC: z.number(), conditions: z.enum(["sunny", "rain"]) }
    },
    async ({ city }) => {
      const out = { city, tempC: city.length * 3, conditions: city.length % 2 ? "rain" : "sunny" };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    }
  );

  // No output schema, plain text result.
  server.registerTool(
    "add",
    { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: "text", text: `The sum is ${a + b}` }] })
  );

  // No output schema, JSON text result.
  server.registerTool("files.list", { description: "List demo files (dotted name)" }, async () => ({
    content: [{ type: "text", text: JSON.stringify([{ name: "a.txt" }, { name: "b.txt" }]) }]
  }));

  // Tool-level error.
  server.registerTool("always-fails", { description: "Always returns isError" }, async () => ({
    isError: true,
    content: [{ type: "text", text: "upstream exploded" }]
  }));

  // The server process's own environment: shows what reached it.
  server.registerTool("print-env", { description: "Return this server's environment variable names" }, async () => ({
    content: [{ type: "text", text: JSON.stringify(Object.keys(process.env).sort()) }]
  }));

  server.registerTool(
    "slow",
    { description: "Wait, then answer", inputSchema: { ms: z.number() } },
    async ({ ms }) => {
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: "text", text: "done" }] };
    }
  );

  return server;
}

/**
 * Streamable HTTP server on 127.0.0.1 that requires `Authorization: Bearer <token>`.
 * Returns the URL, the headers it received, and a close function.
 */
export async function startHttpTestServer(token) {
  const seenAuth = [];
  const httpServer = http.createServer(async (req, res) => {
    seenAuth.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    // Stateless mode: one server + transport per request.
    const mcp = createTestServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const { port } = httpServer.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenAuth,
    close: () => new Promise((r) => { httpServer.closeAllConnections(); httpServer.close(r); })
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await createTestServer().connect(new StdioServerTransport());
}
