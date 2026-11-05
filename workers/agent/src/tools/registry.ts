/**
 * Host tools exposed to Code Mode programs, grouped by sandbox namespace:
 *
 *   fs.*        session workspace files (host-side, path-contained)
 *   sandbox.*   Python / Node.js / shell in Docker, plus allowlisted package installs
 *   web.*       outbound HTTP GET/POST from the host, blocked for private networks
 *   codemode.*  tool discovery
 *
 * The LLM never calls these directly: it writes one program that calls them, and the
 * Code Mode executor dispatches each call back here.
 */
import dns from "node:dns/promises";
import net from "node:net";
import type { ResolvedProvider } from "@cloudflare/codemode";
import type { DockerSandbox } from "../sandbox/docker.js";
import type { PackageInstaller } from "../sandbox/packages.js";
import type { WorkspaceManager } from "../sandbox/workspace.js";
import type { JsonSchema } from "../providers/provider-interface.js";

export interface ToolContext {
  sessionId: string;
  runId: string;
  executionId: string;
  signal?: AbortSignal;
  onOutput?: (source: string, stream: "stdout" | "stderr", chunk: string) => void;
}

export interface ToolSpec {
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  execute: (args: any, ctx: ToolContext) => Promise<unknown>;
}

export interface NamespaceSpec {
  name: string;
  description: string;
  tools: Record<string, ToolSpec>;
}

export interface ToolObserver {
  onToolCall?: (e: { callId: string; namespace: string; tool: string; args: unknown }) => void;
  onToolResult?: (e: {
    callId: string;
    namespace: string;
    tool: string;
    ok: boolean;
    durationMs: number;
    result?: unknown;
    error?: string;
  }) => void;
}

export interface ToolDeps {
  workspace: WorkspaceManager;
  sandbox: DockerSandbox;
  packages: PackageInstaller;
  fetch?: typeof fetch;
}

const runResultSchema: JsonSchema = {
  type: "object",
  properties: {
    stdout: { type: "string" },
    stderr: { type: "string" },
    exitCode: { type: ["number", "null"] },
    timedOut: { type: "boolean" },
    durationMs: { type: "number" }
  },
  required: ["stdout", "stderr", "exitCode", "timedOut", "durationMs"]
};

export function createToolNamespaces(deps: ToolDeps): NamespaceSpec[] {
  const { workspace, sandbox, packages } = deps;
  const fetchImpl = deps.fetch ?? fetch;

  const runIn = async (ctx: ToolContext, source: string, argv: string[], stdin: string | undefined, timeoutMs?: number) => {
    const mountDir = await workspace.mountPath(ctx.sessionId);
    const r = await sandbox.run({
      mountDir,
      argv,
      stdin,
      timeoutMs: clampTimeout(timeoutMs, sandbox.limits.timeoutMs),
      onOutput: (stream, chunk) => ctx.onOutput?.(source, stream, chunk)
    });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, truncated: r.truncated };
  };

  const namespaces: NamespaceSpec[] = [
    {
      name: "fs",
      description: "Read and write files in the session workspace (/workspace in the sandbox).",
      tools: {
        listFiles: {
          description: "List files in the workspace (recursive). Paths are relative to the workspace root.",
          inputSchema: { type: "object", properties: { path: { type: "string", description: "Sub-directory, default root" } } },
          outputSchema: {
            type: "object",
            properties: {
              files: {
                type: "array",
                items: { type: "object", properties: { path: { type: "string" }, size: { type: "number" }, modifiedAt: { type: "string" } }, required: ["path", "size", "modifiedAt"] }
              }
            },
            required: ["files"]
          },
          execute: async (a, ctx) => ({ files: await workspace.list(ctx.sessionId, a.path ?? "") })
        },
        readFile: {
          description: "Read a UTF-8 text file from the workspace (max 1 MB).",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          outputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" }, truncated: { type: "boolean" }, size: { type: "number" } },
            required: ["path", "content", "truncated", "size"]
          },
          execute: (a, ctx) => workspace.read(ctx.sessionId, a.path)
        },
        writeFile: {
          description: "Create or overwrite a UTF-8 text file in the workspace (max 5 MB). Files written here are downloadable artifacts.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"]
          },
          outputSchema: { type: "object", properties: { path: { type: "string" }, size: { type: "number" } }, required: ["path", "size"] },
          execute: (a, ctx) => workspace.write(ctx.sessionId, a.path, a.content)
        },
        deleteFile: {
          description: "Delete a file from the workspace.",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          outputSchema: { type: "object", properties: { deleted: { type: "string" } }, required: ["deleted"] },
          execute: (a, ctx) => workspace.remove(ctx.sessionId, a.path)
        }
      }
    },
    {
      name: "sandbox",
      description:
        "Run code in an isolated Docker container (no network, read-only image, memory/CPU limits). The session workspace is mounted at /workspace and is the working directory.",
      tools: {
        runPython: {
          description: "Run a Python 3 script. Print results to stdout. Installed packages (see installPackage) are importable.",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, timeoutMs: { type: "number", description: "Default 20000, max 120000" } },
            required: ["code"]
          },
          outputSchema: runResultSchema,
          execute: (a, ctx) => runIn(ctx, "python", ["python3", "-"], a.code, a.timeoutMs)
        },
        runNode: {
          description: "Run a Node.js 24 script (CommonJS; use require). Wrap async code in an async IIFE. Print results with console.log.",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, timeoutMs: { type: "number" } },
            required: ["code"]
          },
          outputSchema: runResultSchema,
          execute: (a, ctx) => runIn(ctx, "node", ["node", "-"], a.code, a.timeoutMs)
        },
        runShell: {
          description: "Run a shell command with bash inside the sandbox (coreutils available; no network).",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
            required: ["command"]
          },
          outputSchema: runResultSchema,
          execute: (a, ctx) => runIn(ctx, "shell", ["bash", "-c", a.command], undefined, a.timeoutMs)
        },
        installPackage: {
          description:
            "Install an allowlisted pip or npm package into the session workspace so later runPython / runNode calls can import it. Network is enabled only during the install.",
          inputSchema: {
            type: "object",
            properties: {
              manager: { type: "string", enum: ["pip", "npm"] },
              name: { type: "string" },
              version: { type: "string" }
            },
            required: ["manager", "name"]
          },
          outputSchema: {
            type: "object",
            properties: { installed: { type: "string" }, exitCode: { type: ["number", "null"] }, stdout: { type: "string" }, stderr: { type: "string" } },
            required: ["installed", "exitCode", "stdout", "stderr"]
          },
          execute: async (a, ctx) => {
            const mountDir = await workspace.mountPath(ctx.sessionId);
            const r = await packages.install(mountDir, a.manager, a.name, a.version);
            ctx.onOutput?.("install", r.exitCode === 0 ? "stdout" : "stderr", `${r.installed}: exit ${r.exitCode}\n`);
            if (r.exitCode !== 0) throw new Error(`Install of ${r.installed} failed (exit ${r.exitCode}): ${r.stderr.slice(-800)}`);
            return { installed: r.installed, exitCode: r.exitCode, stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-2000) };
          }
        },
        listAllowedPackages: {
          description: "List packages that installPackage is allowed to install.",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: { packages: { type: "array", items: { type: "object", properties: { manager: { type: "string" }, name: { type: "string" } } } } },
            required: ["packages"]
          },
          execute: async () => ({ packages: packages.allowlist() })
        }
      }
    },
    {
      name: "web",
      description: "HTTP requests to public internet hosts (private, loopback and metadata addresses are blocked).",
      tools: {
        fetch: {
          description: "Fetch a public URL. Returns status, content type and body text (max 200 KB). JSON bodies are also parsed into `json`.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              method: { type: "string", enum: ["GET", "POST"] },
              headers: { type: "object", additionalProperties: { type: "string" } },
              body: { type: "string" }
            },
            required: ["url"]
          },
          outputSchema: {
            type: "object",
            properties: {
              status: { type: "number" },
              contentType: { type: "string" },
              body: { type: "string" },
              json: {},
              truncated: { type: "boolean" }
            },
            required: ["status", "contentType", "body", "truncated"]
          },
          execute: (a, ctx) => safeFetch(fetchImpl, a, ctx.signal)
        }
      }
    }
  ];

  namespaces.push({
    name: "codemode",
    description: "Tool discovery.",
    tools: {
      searchTools: {
        description: "Search the available tools by keyword. Returns matching tool names with descriptions.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        outputSchema: {
          type: "object",
          properties: {
            tools: { type: "array", items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } } } }
          },
          required: ["tools"]
        },
        execute: async (a) => {
          const q = String(a.query ?? "").toLowerCase();
          const tools = namespaces.flatMap((ns) =>
            Object.entries(ns.tools).map(([name, t]) => ({ name: `${ns.name}.${name}`, description: t.description }))
          );
          return { tools: q ? tools.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(q)) : tools };
        }
      }
    }
  });

  return namespaces;
}

/** Bind namespaces to one execution: validates args and reports every tool call. */
export function bindProviders(namespaces: NamespaceSpec[], ctx: ToolContext, observer: ToolObserver = {}): ResolvedProvider[] {
  let counter = 0;
  return namespaces.map((ns) => ({
    name: ns.name,
    fns: Object.fromEntries(
      Object.entries(ns.tools).map(([toolName, spec]) => [
        toolName,
        async (rawArgs: unknown) => {
          const callId = `${ctx.executionId}:${++counter}`;
          const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
          observer.onToolCall?.({ callId, namespace: ns.name, tool: toolName, args: redactLarge(args) });
          const started = Date.now();
          try {
            validateArgs(`${ns.name}.${toolName}`, spec.inputSchema, args);
            const result = await spec.execute(args, ctx);
            observer.onToolResult?.({ callId, namespace: ns.name, tool: toolName, ok: true, durationMs: Date.now() - started, result: redactLarge(result) });
            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            observer.onToolResult?.({ callId, namespace: ns.name, tool: toolName, ok: false, durationMs: Date.now() - started, error: message });
            throw new Error(message);
          }
        }
      ])
    )
  }));
}

/** Minimal JSON-Schema check for tool inputs: required keys and primitive types. */
export function validateArgs(toolName: string, schema: JsonSchema, args: Record<string, unknown>) {
  const required = (schema.required as string[] | undefined) ?? [];
  const props = (schema.properties as Record<string, { type?: string | string[]; enum?: unknown[] }> | undefined) ?? {};
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) throw new Error(`${toolName}: missing required argument "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const p = props[key];
    if (!p || value === undefined) continue;
    const types = p.type === undefined ? [] : Array.isArray(p.type) ? p.type : [p.type];
    if (types.length) {
      const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const ok = types.some((t) => t === actual || (t === "integer" && typeof value === "number"));
      if (!ok) throw new Error(`${toolName}: argument "${key}" must be ${types.join(" | ")}, got ${actual}`);
    }
    if (p.enum && !p.enum.includes(value)) throw new Error(`${toolName}: argument "${key}" must be one of ${p.enum.join(", ")}`);
  }
}

function clampTimeout(requested: unknown, def: number): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? requested : def;
  return Math.max(1_000, Math.min(n, 120_000));
}

function redactLarge(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    if (s && s.length > 4000) return { preview: s.slice(0, 4000) + "…", truncated: true, bytes: s.length };
  } catch {
    return String(v);
  }
  return v;
}

// ------------------------------------------------------------------ web.fetch

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new Error(`Blocked host: ${host}`);
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error(`Blocked: ${host} resolves to a private or reserved address`);
  return url;
}

async function safeFetch(
  fetchImpl: typeof fetch,
  a: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal
) {
  let url = await assertPublicUrl(a.url);
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response | undefined;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetchImpl(url, {
      method: a.method ?? "GET",
      headers: { "user-agent": "AgentOS/0.1", ...(a.headers ?? {}) },
      body: a.method === "POST" ? a.body : undefined,
      redirect: "manual",
      signal: combined
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = await assertPublicUrl(new URL(loc, url).href);
      continue;
    }
    break;
  }
  if (!res) throw new Error("No response");
  const limit = 200_000;
  const reader = res.body?.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  let truncated = false;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > limit) {
        chunks.push(value.slice(0, limit - received));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      received += value.length;
    }
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const contentType = res.headers.get("content-type") ?? "";
  let json: unknown;
  if (contentType.includes("json") && !truncated) {
    try {
      json = JSON.parse(body);
    } catch {
      /* not JSON */
    }
  }
  return { status: res.status, contentType, body: json !== undefined ? body.slice(0, 20_000) : body, json, truncated };
}
