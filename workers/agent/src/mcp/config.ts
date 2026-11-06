/**
 * MCP server configuration.
 *
 * Servers are declared in a JSON file (MCP_CONFIG_FILE, e.g. `mcp.json`) and/or inline
 * in MCP_SERVERS, using the same shape as Claude Desktop / Cursor configs:
 *
 *   { "mcpServers": {
 *       "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] },
 *       "docs":       { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 *   } }
 *
 * `${VAR}` placeholders in args, env, url and headers are filled from the agent's
 * environment (.env), so the config file can be committed without secrets. A server
 * whose placeholder is unset is reported as failed in the status; it does not stop startup.
 * A malformed file, on the other hand, is a configuration error and does stop startup.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const common = {
  /** Namespace the program uses (`github.search(...)`). Defaults to the sanitized server name. */
  namespace: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Per-call timeout for this server's tools, overrides MCP_CALL_TIMEOUT_MS. */
  timeoutMs: z.number().int().positive().optional()
};

const StdioServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    ...common
  })
  .strict();

const HttpServerSchema = z
  .object({
    type: z.enum(["http", "streamable-http", "streamableHttp"]).optional(),
    url: z.string().trim().min(1),
    headers: z.record(z.string(), z.string()).default({}),
    ...common
  })
  .strict();

type ServerEntry = z.infer<typeof StdioServerSchema> | z.infer<typeof HttpServerSchema>;

const ServerNameSchema = z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/, "server names are 1-64 letters, digits, '.', '_' or '-'");

interface BaseServer {
  /** Name from the config file, e.g. "server-everything". */
  name: string;
  /** Requested namespace (sanitized and checked later). */
  namespace?: string;
  description?: string;
  enabled: boolean;
  timeoutMs?: number;
  /** Set when the entry cannot be used (e.g. an unset `${VAR}`). Reported in the status. */
  error?: string;
}

export interface StdioServerConfig extends BaseServer {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Display form with `${VAR}` placeholders left in place, safe to show in the UI. */
  display: string;
}

export interface HttpServerConfig extends BaseServer {
  transport: "http";
  url: string;
  headers: Record<string, string>;
  display: string;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/** Parse MCP_CONFIG_FILE and MCP_SERVERS. Inline servers override file entries with the same name. */
export function loadMcpServers(opts: { file?: string; inline?: string; baseDir: string; env: NodeJS.ProcessEnv }): McpServerConfig[] {
  const entries = new Map<string, ServerEntry>();
  if (opts.file) {
    const file = path.resolve(opts.baseDir, opts.file);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`MCP_CONFIG_FILE: cannot read ${file}: ${(e as Error).message}`);
    }
    for (const [k, v] of Object.entries(parseServers(raw, `MCP_CONFIG_FILE (${file})`))) entries.set(k, v);
  }
  if (opts.inline && opts.inline.trim()) {
    for (const [k, v] of Object.entries(parseServers(opts.inline, "MCP_SERVERS"))) entries.set(k, v);
  }
  return [...entries].map(([name, s]) => resolveServer(name, s, opts.env, opts.baseDir));
}

function parseServers(raw: string, source: string): Record<string, ServerEntry> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${source}: invalid JSON: ${(e as Error).message}`);
  }
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(json)) throw new Error(`${source}: expected an object like { "mcpServers": { "<name>": { ... } } }`);
  const map = "mcpServers" in json ? json.mcpServers : json;
  if (!isObject(map)) throw new Error(`${source}: "mcpServers" must be an object`);
  const out: Record<string, ServerEntry> = {};
  const issues: string[] = [];
  for (const [name, entry] of Object.entries(map)) {
    const n = ServerNameSchema.safeParse(name);
    if (!n.success) issues.push(`"${name}": ${n.error.issues[0].message}`);
    const schema = isObject(entry) && "command" in entry ? StdioServerSchema : isObject(entry) && "url" in entry ? HttpServerSchema : undefined;
    if (!schema) {
      issues.push(`"${name}": needs either "command" (stdio server) or "url" (Streamable HTTP server)`);
      continue;
    }
    const parsed = schema.safeParse(entry);
    if (parsed.success) out[name] = parsed.data;
    else issues.push(...parsed.error.issues.map((i) => `"${name}".${i.path.join(".")}: ${i.message}`));
  }
  if (issues.length) throw new Error(`${source}: ${issues.join("; ")}`);
  return out;
}

function resolveServer(name: string, s: ServerEntry, env: NodeJS.ProcessEnv, baseDir: string): McpServerConfig {
  const missing = new Set<string>();
  const fill = (v: string) =>
    v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => {
      const value = env[key];
      if (value === undefined || value === "") missing.add(key);
      return value ?? "";
    });
  const base = { name, namespace: s.namespace, description: s.description, enabled: s.enabled, timeoutMs: s.timeoutMs };
  let out: McpServerConfig;
  if ("command" in s) {
    out = {
      ...base,
      transport: "stdio",
      command: fill(s.command),
      args: s.args.map(fill),
      env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, fill(v)])),
      cwd: s.cwd ? path.resolve(baseDir, fill(s.cwd)) : undefined,
      display: [s.command, ...s.args].join(" ")
    };
  } else {
    out = {
      ...base,
      transport: "http",
      url: fill(s.url),
      headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, fill(v)])),
      display: displayUrl(s.url)
    };
    if (!out.error) {
      try {
        const u = new URL(out.url);
        if (u.protocol !== "http:" && u.protocol !== "https:") out.error = `Unsupported URL protocol ${u.protocol}`;
      } catch {
        out.error = `Invalid URL: ${out.display}`;
      }
    }
  }
  if (missing.size) out.error = `Environment variable${missing.size > 1 ? "s" : ""} ${[...missing].join(", ")} not set (referenced in the config)`;
  return out;
}

/** URL without credentials or query string, so tokens embedded in a URL never reach the UI. */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "VAR_$1"));
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/VAR_([A-Za-z_][A-Za-z0-9_]*)/g, "${$1}");
  } catch {
    return raw.split("?")[0].replace(/\/\/[^/@]*@/, "//");
  }
}
