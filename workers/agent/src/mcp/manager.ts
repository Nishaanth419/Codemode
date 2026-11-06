/**
 * Owns every configured MCP server: connects them at startup, keeps one Code Mode
 * namespace per connected server, and reports health for /api/status and the UI.
 *
 * A server that is down never blocks the agent. Its namespace is simply absent from new
 * runs until it reconnects, and its error is visible in the status.
 */
import { EventEmitter } from "node:events";
import type { NamespaceSpec } from "../tools/registry.js";
import type { McpServerConfig } from "./config.js";
import { McpServerConnection, type McpConnectionOptions, type McpServerState } from "./connection.js";
import { buildMcpNamespace, resolveNamespace } from "./namespace.js";

export interface McpServerStatus {
  name: string;
  namespace: string;
  transport: "stdio" | "http";
  /** Command line or URL as written in the config (placeholders kept, no query string). */
  target: string;
  description: string | null;
  state: McpServerState;
  error: string | null;
  toolCount: number;
  server: { name: string; version: string } | null;
  connectedAt: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  failures: number;
}

interface Entry {
  conn: McpServerConnection;
  namespace: string;
  spec?: NamespaceSpec;
  version: number;
}

export class McpManager extends EventEmitter {
  private readonly entries: Entry[];
  private initial?: Promise<void>;

  constructor(servers: McpServerConfig[], opts: McpConnectionOptions) {
    super();
    this.setMaxListeners(0); // one listener per open SSE stream
    const taken = new Map<string, string>();
    this.entries = servers.map((server) => {
      const { namespace, error: nsError } = resolveNamespace(server.namespace ?? server.name);
      let error = server.error ?? nsError;
      const owner = taken.get(namespace);
      if (!error && owner) error = `Namespace "${namespace}" is already used by MCP server "${owner}"; set "namespace" for this server`;
      if (!error) taken.set(namespace, server.name);
      const conn = new McpServerConnection(error ? { ...server, error } : server, opts);
      const entry: Entry = { conn, namespace, version: 0 };
      conn.on("change", () => void this.refresh(entry));
      return entry;
    });
  }

  get size() {
    return this.entries.length;
  }

  /** Connect every enabled server once. Resolves when all first attempts have settled. */
  start(): Promise<void> {
    this.initial ??= Promise.all(
      this.entries.map(async (e) => {
        await e.conn.connect();
        await this.refresh(e);
      })
    ).then(() => undefined);
    return this.initial;
  }

  /** Wait (bounded) for the startup connections, so the first run sees servers that are still connecting. */
  async waitForInitial(maxMs: number): Promise<void> {
    if (!this.initial) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.initial, new Promise<void>((r) => (timer = setTimeout(r, maxMs)))]);
    clearTimeout(timer);
  }

  /** Namespaces of the connected servers, in config order. */
  namespaces(): NamespaceSpec[] {
    return this.entries.flatMap((e) => (e.spec && e.conn.state === "connected" ? [e.spec] : []));
  }

  status(): McpServerStatus[] {
    return this.entries.map(({ conn, namespace }) => ({
      name: conn.config.name,
      namespace,
      transport: conn.config.transport,
      target: conn.config.display,
      description: conn.config.description ?? null,
      state: conn.state,
      error: conn.error ?? null,
      toolCount: conn.state === "connected" ? conn.tools.length : 0,
      server: conn.serverInfo ?? null,
      connectedAt: conn.connectedAt ?? null,
      lastAttemptAt: conn.lastAttemptAt ?? null,
      nextRetryAt: conn.nextRetryAt ?? null,
      failures: conn.failures
    }));
  }

  async close(): Promise<void> {
    await Promise.all(this.entries.map((e) => e.conn.close()));
  }

  private async refresh(entry: Entry): Promise<void> {
    const version = ++entry.version;
    let spec: NamespaceSpec | undefined;
    if (entry.conn.state === "connected") {
      try {
        spec = await buildMcpNamespace(entry.namespace, entry.conn);
      } catch (err) {
        entry.conn.error = `Could not build the tool API: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (version !== entry.version) return; // a newer refresh superseded this one
    entry.spec = spec;
    this.emit("change");
  }
}
