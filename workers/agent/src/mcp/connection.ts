/**
 * One MCP server connection: transport, handshake, tool list, reconnects.
 *
 * Credentials (stdio `env`, HTTP `headers`) live only here, in the agent process. Code Mode
 * programs never get this object: they call typed stubs whose calls arrive as JSON and are
 * forwarded through `callTool`.
 *
 * A server that fails to start or drops later is retried with exponential backoff. Until it
 * is back, its namespace is left out of new runs and the status endpoint shows the error.
 */
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";

export type McpServerState = "disabled" | "connecting" | "connected" | "error";

export interface McpConnectionOptions {
  /** Limit for spawning / reaching the server, the MCP handshake and the first tools/list. */
  connectTimeoutMs: number;
  /** Default per-call timeout (a server's `timeoutMs` overrides it). */
  callTimeoutMs: number;
  /** Longest wait between reconnect attempts. */
  reconnectMaxMs: number;
  /** Test hook: build the transport yourself (e.g. an InMemoryTransport); return undefined for the default. */
  createTransport?: (server: McpServerConfig) => Transport | undefined | Promise<Transport | undefined>;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  toolResult?: unknown;
  [key: string]: unknown;
}

const CLIENT_INFO = { name: "agentos", version: "0.1.0" };

export class McpServerConnection extends EventEmitter {
  state: McpServerState;
  error?: string;
  tools: Tool[] = [];
  serverInfo?: { name: string; version: string };
  instructions?: string;
  connectedAt?: string;
  lastAttemptAt?: string;
  nextRetryAt?: string;
  /** Consecutive failed attempts; reset by a successful connection. */
  failures = 0;

  private client?: Client;
  private retryTimer?: NodeJS.Timeout;
  private generation = 0;
  private closed = false;
  private stderrTail = "";

  constructor(
    readonly config: McpServerConfig,
    private readonly opts: McpConnectionOptions
  ) {
    super();
    this.state = config.error ? "error" : config.enabled ? "connecting" : "disabled";
    this.error = config.error;
  }

  get usable(): boolean {
    return this.config.enabled && !this.config.error;
  }

  /** One connection attempt. Never rejects; on failure it records the error and schedules a retry. */
  async connect(): Promise<void> {
    if (this.closed || !this.usable) return;
    const gen = ++this.generation;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.nextRetryAt = undefined;
    this.lastAttemptAt = new Date().toISOString();
    this.stderrTail = "";
    this.setState("connecting");

    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      transport = await this.createTransport();
      client = new Client(CLIENT_INFO, {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (err, tools) => {
              if (gen !== this.generation || this.closed) return;
              if (err) return;
              this.tools = tools ?? [];
              this.emit("change");
            }
          }
        }
      });
      client.onclose = () => {
        if (gen === this.generation && !this.closed && this.state === "connected") this.lostConnection("connection closed");
      };
      const timeout = this.opts.connectTimeoutMs;
      await withTimeout(client.connect(transport, { timeout }), timeout, `MCP handshake timed out after ${timeout}ms`);
      const tools = await listAllTools(client, timeout);
      if (gen !== this.generation || this.closed) {
        await client.close().catch(() => {});
        return;
      }
      this.client = client;
      this.tools = tools;
      const info = client.getServerVersion();
      this.serverInfo = info ? { name: info.name, version: info.version } : undefined;
      this.instructions = client.getInstructions();
      this.connectedAt = new Date().toISOString();
      this.failures = 0;
      this.error = undefined;
      this.setState("connected");
    } catch (err) {
      await (client ? client.close() : transport?.close())?.catch(() => {});
      if (gen !== this.generation || this.closed) return;
      this.fail(this.describe(err));
    }
  }

  /** Call a tool by its real MCP name. Throws when the server is not connected or the transport fails. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const client = this.client;
    if (!client || this.state !== "connected") {
      throw new Error(`MCP server "${this.config.name}" is not connected${this.error ? ` (${this.error})` : ""}`);
    }
    const timeout = this.config.timeoutMs ?? this.opts.callTimeoutMs;
    return (await client.callTool({ name, arguments: args }, undefined, { timeout, signal })) as McpCallResult;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }

  private async createTransport(): Promise<Transport> {
    const s = this.config;
    const custom = await this.opts.createTransport?.(s);
    if (custom) return custom;
    if (s.transport === "stdio") {
      // Only the SDK's minimal default environment (PATH, HOME, USER, ...) plus the server's own
      // `env` is passed on: the agent's LLM keys never reach an MCP server process.
      const t = new StdioClientTransport({
        command: s.command,
        args: s.args,
        env: { ...getDefaultEnvironment(), ...s.env },
        cwd: s.cwd,
        stderr: "pipe"
      });
      t.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2_000);
      });
      return t;
    }
    return new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers } });
  }

  private lostConnection(reason: string) {
    this.client = undefined;
    this.fail(`Disconnected: ${reason}`);
  }

  private fail(message: string) {
    this.client = undefined;
    this.failures++;
    this.error = message;
    const delay = Math.min(1_000 * 2 ** Math.min(this.failures - 1, 10), this.opts.reconnectMaxMs);
    this.nextRetryAt = new Date(Date.now() + delay).toISOString();
    this.retryTimer = setTimeout(() => void this.connect(), delay);
    this.retryTimer.unref?.();
    this.setState("error");
  }

  private setState(state: McpServerState) {
    this.state = state;
    this.emit("change");
  }

  private describe(err: unknown): string {
    let msg = err instanceof Error ? err.message : String(err);
    // Node's fetch reports "fetch failed" and hides the reason (ECONNREFUSED, ENOTFOUND, ...) in `cause`.
    const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
    if (cause && (cause.code || cause.message)) msg += ` (${[cause.code, cause.message].filter(Boolean).join(": ")})`;
    if (this.config.transport === "http") msg = msg.replaceAll(this.config.url, this.config.display);
    const tail = this.stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    return tail ? `${msg} (stderr: ${tail.slice(-500)})` : msg;
  }
}

async function listAllTools(client: Client, timeout: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await client.listTools(cursor ? { cursor } : undefined, { timeout });
    tools.push(...r.tools);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
