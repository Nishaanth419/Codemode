/**
 * Code Mode integration.
 *
 * Follows @cloudflare/codemode's `createCodeTool` design without its AI SDK wrapper
 * (AgentOS has its own provider layer):
 *   - TypeScript declarations for every tool namespace come from the package's
 *     `generateTypesFromJsonSchema`.
 *   - The LLM gets exactly ONE tool, `codemode`, whose input is `{ code }`.
 *   - The program runs through the package's `runCode`, which applies `normalizeCode`
 *     and calls our `Executor` (local worker isolate or Docker).
 */
import { generateTypesFromJsonSchema, runCode, type Executor } from "@cloudflare/codemode";
import type { ToolDefinition } from "../providers/provider-interface.js";
import type { NamespaceSpec, ToolContext, ToolObserver } from "../tools/registry.js";
import { bindProviders } from "../tools/registry.js";

export const CODEMODE_TOOL_NAME = "codemode";

/**
 * Shared result type for MCP tools without an `outputSchema`. It matches what
 * McpConnector's unwrapping returns (see mcp/namespace.ts).
 */
export const MCP_RESULT_TYPES = `/** Result of an MCP tool that declares no output schema: its text output (JSON-parsed when the text is JSON), or the raw MCP result when it contains images, audio or resources. */
type McpToolResult = string | number | boolean | null | unknown[] | { [key: string]: unknown } | { content: McpContent[] };
type McpContent =
    | { type: "text"; text: string }
    | { type: "image" | "audio"; data: string; mimeType: string }
    | { type: "resource" | "resource_link"; [key: string]: unknown };`;

const MCP_RESULT_MARKER = "__agentos_mcp_tool_result__";

/** TypeScript declarations for one namespace, e.g. `declare const sandbox: {...}`. */
export function namespaceTypes(ns: NamespaceSpec, opts: { sharedTypes?: boolean } = {}): string {
  const mcp = ns.source === "mcp";
  let untyped = false;
  const descriptors = Object.fromEntries(
    Object.entries(ns.tools).map(([name, t]) => {
      let outputSchema = t.outputSchema;
      if (!outputSchema && mcp) {
        untyped = true;
        outputSchema = { type: "string", enum: [MCP_RESULT_MARKER] };
      }
      return [name, { description: t.description, inputSchema: t.inputSchema, outputSchema }];
    })
  );
  const types = generateTypesFromJsonSchema(descriptors as never).replaceAll(`"${MCP_RESULT_MARKER}"`, "McpToolResult");
  const shared = untyped && (opts.sharedTypes ?? true) ? `${MCP_RESULT_TYPES}\n` : "";
  return `/** ${ns.description.replace(/\*\//g, "*\\/")} */\n${shared}${types.replace(/declare const codemode\s*:/, `declare const ${ns.name}:`)}`;
}

export function buildTypesBlock(namespaces: NamespaceSpec[]): string {
  const needsShared = namespaces.some((ns) => ns.source === "mcp" && Object.values(ns.tools).some((t) => !t.outputSchema));
  const blocks = namespaces.map((ns) => namespaceTypes(ns, { sharedTypes: false }));
  return [...(needsShared ? [MCP_RESULT_TYPES] : []), ...blocks].join("\n\n");
}

export function buildCodeToolDefinition(namespaces: NamespaceSpec[]): ToolDefinition {
  return {
    name: CODEMODE_TOOL_NAME,
    description: `Execute JavaScript to achieve a goal. The code runs in an isolated sandbox where these APIs are available as globals:

${buildTypesBlock(namespaces)}

Write an async arrow function in JavaScript that returns the result.
Do NOT use TypeScript syntax: no type annotations, interfaces, or generics.
Do NOT define named functions then call them; write the arrow function body directly.
console.log output is captured. There is no require, import, process, or fetch; use the APIs above.

Example: async () => { const r = await sandbox.runPython({ code: "print(2**10)" }); return r.stdout.trim(); }`,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "An async arrow function, e.g. async () => { ... }" }
      },
      required: ["code"]
    }
  };
}

export interface CodeExecutionOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
}

/** Run one Code Mode program with the given namespaces bound to this execution. */
export async function executeCodeMode(opts: {
  code: string;
  executor: Executor;
  namespaces: NamespaceSpec[];
  ctx: ToolContext;
  observer?: ToolObserver;
}): Promise<CodeExecutionOutcome> {
  const started = Date.now();
  const providers = bindProviders(opts.namespaces, { catalog: opts.namespaces, ...opts.ctx }, opts.observer);
  try {
    const out = await runCode({ code: opts.code, executor: opts.executor, providers });
    return { ok: true, result: out.result, logs: out.logs ?? [], durationMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // runCode appends "Console output:" to the error; keep the first part as the error.
    const [head] = message.split("\n\nConsole output:\n");
    const logs = message.includes("\n\nConsole output:\n") ? message.split("\n\nConsole output:\n")[1].split("\n") : [];
    return { ok: false, error: head.replace(/^Code execution failed: /, ""), logs, durationMs: Date.now() - started };
  }
}
