/**
 * MCP server → Code Mode namespace.
 *
 * Uses @cloudflare/codemode's `McpConnector`, which turns each MCP tool into a connector
 * tool: names are sanitized into JS identifiers (`get-sum` → `get_sum`) and results are
 * unwrapped (`isError` throws, `structuredContent` is returned as is, text content is
 * JSON-parsed when possible). The connector's tools are then wrapped in a `NamespaceSpec`,
 * so the same pipeline as the built-in tools generates their TypeScript declarations
 * (`namespaceTypes` in codemode/code-tool.ts) and binds them to executions.
 */
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpConnector, sanitizeToolName, type McpConnectionLike } from "@cloudflare/codemode";
import type { JsonSchema } from "../providers/provider-interface.js";
import type { NamespaceSpec, ToolSpec } from "../tools/registry.js";
import type { McpServerConnection } from "./connection.js";

/** Names a server namespace may not take: built-in namespaces and the program's own globals. */
export const BUILTIN_NAMESPACES = ["fs", "sandbox", "web", "codemode"];
const RESERVED = new Set<string>([
  ...BUILTIN_NAMESPACES,
  "console",
  "setTimeout",
  "clearTimeout",
  ...(vm.runInContext("Object.getOwnPropertyNames(globalThis)", vm.createContext()) as string[])
]);

/** Validates and sanitizes the namespace a server will use inside programs. */
export function resolveNamespace(requested: string): { namespace: string; error?: string } {
  const namespace = sanitizeToolName(requested);
  if (RESERVED.has(namespace)) {
    return { namespace, error: `Namespace "${namespace}" is reserved; set "namespace" for this server in the MCP config` };
  }
  return { namespace };
}

const UNSTRUCTURED_NOTE = "Tools typed McpToolResult have no MCP output schema. A tool error is thrown.";

/** Carries the run's abort signal from `execute` to `callTool`, through the connector. */
const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

class ServerConnector extends McpConnector {
  /** Sanitized tool name → real MCP tool name. */
  readonly toolNames = new Map<string, string>();

  constructor(
    private readonly namespace: string,
    private readonly conn: McpServerConnection
  ) {
    // The Workers ctx/env are unused on Node (see shims/cloudflare-workers.ts).
    super(undefined as never, undefined);
  }

  name() {
    return this.namespace;
  }

  protected createConnection(): McpConnectionLike {
    const conn = this.conn;
    return {
      name: this.namespace,
      tools: conn.tools as McpConnectionLike["tools"],
      client: { callTool: (p) => conn.callTool(p.name, p.arguments ?? {}, callSignal.getStore()) }
    };
  }

  /** Keeps the package's sanitizing, but suffixes `_2`, `_3` instead of failing when two names collide. */
  protected toolName(tool: { name: string }): string {
    const base = super.toolName(tool as never);
    let name = base;
    for (let i = 2; this.toolNames.has(name); i++) name = `${base}_${i}`;
    this.toolNames.set(name, tool.name);
    return name;
  }
}

/** Build the namespace for a connected server from its current tool list. */
export async function buildMcpNamespace(namespace: string, conn: McpServerConnection): Promise<NamespaceSpec> {
  const connector = new ServerConnector(namespace, conn);
  const { descriptors } = await connector.describe();
  const server = conn.config.name;
  const tools: Record<string, ToolSpec> = {};
  let unstructured = false;
  for (const [name, d] of Object.entries(descriptors)) {
    const mcpName = connector.toolNames.get(name) ?? name;
    const mcpTool = conn.tools.find((t) => t.name === mcpName);
    if (!d.outputSchema) unstructured = true;
    tools[name] = {
      description: d.description?.trim() || mcpTool?.title || mcpName,
      inputSchema: (d.inputSchema ?? { type: "object" }) as JsonSchema,
      // Left undefined when the server declares none: namespaceTypes() then types it McpToolResult.
      outputSchema: d.outputSchema as JsonSchema | undefined,
      mcpName,
      execute: async (args, ctx) => {
        try {
          return await callSignal.run(ctx.signal, () => connector.executeTool(name, args));
        } catch (err) {
          throw new Error(`${server}/${mcpName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
  }
  const info = conn.serverInfo ? ` (${conn.serverInfo.name} ${conn.serverInfo.version})` : "";
  const about = conn.config.description ?? firstParagraph(conn.instructions);
  return {
    name: namespace,
    description: [`Tools from the MCP server "${server}"${info}.`, about, unstructured ? UNSTRUCTURED_NOTE : undefined].filter(Boolean).join(" "),
    source: "mcp",
    server,
    tools
  };
}

function firstParagraph(text?: string): string | undefined {
  const p = text?.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ");
  if (!p) return undefined;
  return p.length > 300 ? `${p.slice(0, 297)}…` : p;
}
