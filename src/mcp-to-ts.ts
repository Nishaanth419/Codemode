/**
 * mcp-to-ts.ts — MCP schema fetcher and tool descriptor conversion
 *
 * Connects to an MCP server over Streamable HTTP, fetches tool schemas, and
 * converts those schemas to Zod for direct model tool calling.
 */

import { z } from "zod";

// ─── MCP Protocol Types ────────────────────────────────────────────────────
// We define just enough of the MCP protocol to fetch tool lists.
// The full MCP spec is at https://modelcontextprotocol.io/specification

/** A single property in a JSON Schema object */
interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
}

/** An MCP tool definition as returned by tools/list */
interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

/** Tool descriptor used to create an AI SDK tool. */
export interface GeneratedTool {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  /** TypeScript declaration string, e.g. `(query: string, limit?: number) => Promise<unknown>` */
  tsSignature: string;
}

// ─── MCP Client (Streamable HTTP) ──────────────────────────────────────────

/**
 * Fetch the list of tools from an MCP server using the Streamable HTTP transport.
 *
 * The Streamable HTTP transport sends JSON-RPC over plain HTTP POST.
 * GitMCP (gitmcp.io) and most modern MCP servers support this.
 *
 * @param serverUrl - Base URL of the MCP server (e.g., "https://gitmcp.io/cloudflare/agents")
 * @returns Array of MCP tool definitions
 */
export async function fetchMcpSession(serverUrl: string, accessToken?: string): Promise<{
  tools: McpToolDefinition[];
  sessionId: string | null;
  protocolVersion: string;
}> {
  // Step 1: Initialize the MCP session
  const authHeaders: Record<string, string> = accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : {};
  const initResponse = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "code-mode-agent", version: "1.0.0" },
      },
    }),
  });

  if (!initResponse.ok) {
    const authChallenge = initResponse.headers.get("www-authenticate");
    const responseBody = (await initResponse.text()).slice(0, 500);
    const authHint = initResponse.status === 401
      ? accessToken
        ? " INDmoney rejected the saved OAuth token; reconnect the account."
        : " INDmoney requires OAuth sign-in; this request has no user token."
      : "";
    throw new Error(
      `MCP initialize failed: ${initResponse.status} ${initResponse.statusText}.${authHint}` +
      (authChallenge ? ` WWW-Authenticate: ${authChallenge}.` : "") +
      (responseBody ? ` Response: ${responseBody}` : "")
    );
  }

  // Extract session ID from response headers if present
  const sessionId = initResponse.headers.get("mcp-session-id");

  // Parse init response — may be JSON or SSE
  const initResult = await parseJsonRpcResponse(initResponse);
  if (!initResult?.result) {
    throw new Error(`MCP initialize returned unexpected result: ${JSON.stringify(initResult)}`);
  }
  const initializeResult = initResult.result as Record<string, unknown>;
  const protocolVersion = typeof initializeResult.protocolVersion === "string"
    ? initializeResult.protocolVersion
    : initResponse.headers.get("MCP-Protocol-Version") ?? "2025-03-26";

  // Step 2: Send initialized notification
  const notifyHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
  };
  Object.assign(notifyHeaders, authHeaders);
  if (sessionId) {
    notifyHeaders["mcp-session-id"] = sessionId;
  }

  await fetch(serverUrl, {
    method: "POST",
    headers: notifyHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  // Step 3: Fetch tools list
  const toolsHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocolVersion,
  };
  Object.assign(toolsHeaders, authHeaders);
  if (sessionId) {
    toolsHeaders["mcp-session-id"] = sessionId;
  }

  const toolsResponse = await fetch(serverUrl, {
    method: "POST",
    headers: toolsHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });

  if (!toolsResponse.ok) {
    const responseBody = (await toolsResponse.text()).slice(0, 500);
    throw new Error(
      `MCP tools/list failed: ${toolsResponse.status} ${toolsResponse.statusText}` +
      (responseBody ? `. Response: ${responseBody}` : "")
    );
  }

  const toolsResult = await parseJsonRpcResponse(toolsResponse);
  const resultObj = toolsResult?.result as Record<string, unknown> | undefined;
  const tools = resultObj?.tools;

  if (!Array.isArray(tools)) {
    throw new Error(`MCP tools/list returned unexpected result: ${JSON.stringify(toolsResult)}`);
  }

  return { tools: tools as McpToolDefinition[], sessionId, protocolVersion };
}

/** Convenience wrapper for callers that only need the tool definitions. */
export async function fetchMcpTools(serverUrl: string): Promise<McpToolDefinition[]> {
  const session = await fetchMcpSession(serverUrl);
  return session.tools;
}

/**
 * Parse a JSON-RPC response that may come as plain JSON or as an SSE stream.
 * MCP Streamable HTTP can respond with either content type.
 */
async function parseJsonRpcResponse(response: Response): Promise<Record<string, unknown> | null> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    // Parse SSE: look for lines starting with "data: "
    const text = await response.text();
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data && data !== "[DONE]") {
          return JSON.parse(data) as Record<string, unknown>;
        }
      }
    }
    return null;
  }

  // Plain JSON response
  return (await response.json()) as Record<string, unknown>;
}

// ─── JSON Schema → Zod Conversion ─────────────────────────────────────────

/**
 * Convert a JSON Schema property to a Zod schema.
 * Handles the common subset used by MCP tools: string, number, boolean,
 * array, object, and enums.
 */
function jsonSchemaPropertyToZod(prop: JsonSchemaProperty): z.ZodTypeAny {
  if (prop.enum && prop.type === "string") {
    return z.enum(prop.enum as [string, ...string[]]);
  }

  switch (prop.type) {
    case "string":
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(prop.items ? jsonSchemaPropertyToZod(prop.items) : z.unknown());
    case "object":
      if (prop.properties) {
        return jsonSchemaToZodObject(prop.properties, prop.required ?? []);
      }
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Convert a JSON Schema object's properties to a Zod object schema.
 */
function jsonSchemaToZodObject(
  properties: Record<string, JsonSchemaProperty>,
  required: string[]
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodProp = jsonSchemaPropertyToZod(prop);

    // Make optional if not in required array
    if (!required.includes(key)) {
      zodProp = zodProp.optional() as z.ZodTypeAny;
    }

    // Attach description for AI SDK
    if (prop.description) {
      zodProp = zodProp.describe(prop.description);
    }

    shape[key] = zodProp;
  }

  return z.object(shape);
}

// ─── TypeScript Codegen ────────────────────────────────────────────────────

/**
 * Convert a JSON Schema type to its TypeScript equivalent.
 */
function jsonSchemaTypeToTs(prop: JsonSchemaProperty): string {
  if (prop.enum && prop.type === "string") {
    return prop.enum.map((v) => `"${v}"`).join(" | ");
  }

  switch (prop.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const itemType = prop.items ? jsonSchemaTypeToTs(prop.items) : "unknown";
      return `${itemType}[]`;
    }
    case "object": {
      if (prop.properties) {
        const fields = Object.entries(prop.properties)
          .map(([k, v]) => {
            const optional = !(prop.required ?? []).includes(k) ? "?" : "";
            return `${k}${optional}: ${jsonSchemaTypeToTs(v)}`;
          })
          .join("; ");
        return `{ ${fields} }`;
      }
      return "Record<string, unknown>";
    }
    default:
      return "unknown";
  }
}

/**
 * Generate a TypeScript function signature for a tool.
 *
 * Example output:
 * ```
 * (query: string, limit?: number) => Promise<unknown>
 * ```
 */
function generateTsSignature(tool: McpToolDefinition): string {
  const params: string[] = [];

  if (tool.inputSchema.properties) {
    const required = tool.inputSchema.required ?? [];

    for (const [paramName, prop] of Object.entries(tool.inputSchema.properties)) {
      const optional = !required.includes(paramName) ? "?" : "";
      const tsType = jsonSchemaTypeToTs(prop);
      params.push(`${paramName}${optional}: ${tsType}`);
    }
  }

  return `(${params.join(", ")}) => Promise<unknown>`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Convert MCP tool definitions into descriptors with Zod input schemas.
 */
export function mcpToolsToGenerated(mcpTools: McpToolDefinition[]): GeneratedTool[] {
  return mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? `Call the ${tool.name} tool`,
    parameters: tool.inputSchema.properties
      ? jsonSchemaToZodObject(tool.inputSchema.properties, tool.inputSchema.required ?? [])
      : z.object({}),
    tsSignature: generateTsSignature(tool),
  }));
}
