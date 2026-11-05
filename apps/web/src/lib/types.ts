export type ProviderName = "groq" | "gemini" | "ollama";
export type ProviderStatus = "active" | "standby" | "rate_limited" | "unavailable" | "unconfigured";

export interface ProviderHealth {
  name: ProviderName;
  label: string;
  model: string;
  role: "primary" | "fallback" | "optional";
  configured: boolean;
  status: ProviderStatus;
  available: boolean;
  lastSuccessAt: string | null;
  lastError: { kind: string; message: string; summary: string; status?: number; at: string } | null;
  consecutiveFailures: number;
  rateLimited: boolean;
  retryAfter: string | null;
  requestsMade: number;
  successes: number;
  failures: number;
  quotaRemaining: null;
}

export interface SystemStatus {
  llm: {
    currentProvider: ProviderName | null;
    autoFailover: boolean;
    providers: ProviderHealth[];
    primary: ProviderName;
    fallback: ProviderName | null;
    quotaNote: string;
    updatedAt: string;
  };
  executor: { id: string; label: string; managed: false; isolation: string; note: string };
  sandbox: { available: boolean; version?: string; imagePresent: boolean; image: string; error?: string };
  mcp?: { servers: McpServerStatus[] };
}

export type McpServerState = "disabled" | "connecting" | "connected" | "error";

export interface McpServerStatus {
  name: string;
  namespace: string;
  transport: "stdio" | "http";
  /** Command line or URL from the config (placeholders kept, no secrets). */
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

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AgentEvent {
  id: number | null;
  runId: string;
  sessionId: string;
  type: string;
  data: Record<string, any>;
  createdAt: string;
}

export interface Execution {
  id: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  code: string;
  provider: ProviderName;
  model: string;
  executor: string;
  status: "running" | "completed" | "failed";
  result: unknown;
  error: string | null;
  logs: string[];
  toolCalls: { name: string; ok: boolean; durationMs: number; error?: string }[];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ToolNamespace {
  name: string;
  description: string;
  source: "builtin" | "mcp";
  /** MCP server name, for MCP namespaces. */
  server: string | null;
  types: string;
  /** mcpName: the real MCP tool name when it differs from the JS name. */
  tools: { name: string; description: string; mcpName?: string }[];
}
