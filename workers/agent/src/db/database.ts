/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native build step).
 * Stores sessions, conversation messages (with the provider/model that produced
 * each assistant turn), runs, Code Mode executions and every execution event.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ProviderName, ToolCall } from "../providers/provider-interface.js";

export interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  session_id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  user_message: string;
  provider: string | null;
  model: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface ExecutionRow {
  id: string;
  run_id: string;
  session_id: string;
  tool_call_id: string;
  code: string;
  code_hash: string;
  provider: string;
  model: string;
  executor: string;
  status: "running" | "completed" | "failed";
  result: string | null;
  error: string | null;
  logs: string | null;
  tool_calls: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface EventRow {
  id: number;
  run_id: string;
  session_id: string;
  type: string;
  data: string;
  created_at: string;
}

export interface StoredMessage {
  id: number;
  runId: string | null;
  message: ChatMessage;
  createdAt: string;
}

const now = () => new Date().toISOString();

export class AppDatabase {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        user_message TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        provider TEXT,
        model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        code TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        executor TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        logs TEXT,
        tool_calls TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        UNIQUE (run_id, tool_call_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_exec_session ON executions(session_id, started_at);
    `);
  }

  // ---------------------------------------------------------------- sessions

  createSession(id: string, title = "New session"): SessionRow {
    const t = now();
    this.db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, title, t, t);
    return { id, title, created_at: t, updated_at: t };
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  listSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200").all() as unknown as SessionRow[];
  }

  touchSession(id: string, title?: string) {
    if (title) this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, now(), id);
    else this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  deleteSession(id: string) {
    this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------------- messages

  addMessage(sessionId: string, runId: string | null, m: ChatMessage): number {
    const t = now();
    const res =
      m.role === "user"
        ? this.db.prepare("INSERT INTO messages (session_id, run_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)").run(sessionId, runId, m.content, t)
        : m.role === "assistant"
          ? this.db
              .prepare(
                "INSERT INTO messages (session_id, run_id, role, content, tool_calls, provider, model, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)"
              )
              .run(sessionId, runId, m.content ?? "", m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null, m.provider ?? null, m.model ?? null, t)
          : this.db
              .prepare("INSERT INTO messages (session_id, run_id, role, content, tool_call_id, tool_name, created_at) VALUES (?, ?, 'tool', ?, ?, ?, ?)")
              .run(sessionId, runId, m.content, m.toolCallId, m.toolName, t);
    return Number(res.lastInsertRowid);
  }

  listMessages(sessionId: string): StoredMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id").all(sessionId) as any[];
    return rows.map((r) => ({ id: r.id, runId: r.run_id, createdAt: r.created_at, message: rowToMessage(r) }));
  }

  // ---------------------------------------------------------------- runs

  createRun(id: string, sessionId: string, userMessage: string): RunRow {
    const t = now();
    this.db
      .prepare("INSERT INTO runs (id, session_id, status, user_message, created_at) VALUES (?, ?, 'running', ?, ?)")
      .run(id, sessionId, userMessage, t);
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  finishRun(id: string, status: RunRow["status"], info: { provider?: ProviderName; model?: string; error?: unknown } = {}) {
    this.db
      .prepare("UPDATE runs SET status = ?, provider = COALESCE(?, provider), model = COALESCE(?, model), error = ?, finished_at = ? WHERE id = ?")
      .run(status, info.provider ?? null, info.model ?? null, info.error ? JSON.stringify(info.error) : null, now(), id);
  }

  listRuns(sessionId: string): RunRow[] {
    return this.db.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at").all(sessionId) as unknown as RunRow[];
  }

  // ---------------------------------------------------------------- executions

  findExecutionByToolCall(runId: string, toolCallId: string): ExecutionRow | undefined {
    return this.db.prepare("SELECT * FROM executions WHERE run_id = ? AND tool_call_id = ?").get(runId, toolCallId) as ExecutionRow | undefined;
  }

  findCompletedExecutionByHash(runId: string, codeHash: string): ExecutionRow | undefined {
    return this.db
      .prepare("SELECT * FROM executions WHERE run_id = ? AND code_hash = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1")
      .get(runId, codeHash) as ExecutionRow | undefined;
  }

  startExecution(e: Omit<ExecutionRow, "status" | "result" | "error" | "logs" | "tool_calls" | "finished_at" | "duration_ms" | "started_at">): ExecutionRow {
    this.db
      .prepare(
        `INSERT INTO executions (id, run_id, session_id, tool_call_id, code, code_hash, provider, model, executor, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(e.id, e.run_id, e.session_id, e.tool_call_id, e.code, e.code_hash, e.provider, e.model, e.executor, now());
    return this.getExecution(e.id)!;
  }

  finishExecution(id: string, r: { ok: boolean; result?: unknown; error?: string; logs: string[]; toolCalls: unknown[]; durationMs: number }) {
    this.db
      .prepare("UPDATE executions SET status = ?, result = ?, error = ?, logs = ?, tool_calls = ?, finished_at = ?, duration_ms = ? WHERE id = ?")
      .run(
        r.ok ? "completed" : "failed",
        r.ok ? JSON.stringify(r.result ?? null) : null,
        r.error ?? null,
        JSON.stringify(r.logs),
        JSON.stringify(r.toolCalls),
        now(),
        r.durationMs,
        id
      );
  }

  getExecution(id: string): ExecutionRow | undefined {
    return this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecutionRow | undefined;
  }

  listExecutions(sessionId?: string): ExecutionRow[] {
    return (
      sessionId
        ? this.db.prepare("SELECT * FROM executions WHERE session_id = ? ORDER BY started_at DESC LIMIT 200").all(sessionId)
        : this.db.prepare("SELECT * FROM executions ORDER BY started_at DESC LIMIT 200").all()
    ) as unknown as ExecutionRow[];
  }

  countExecutions(runId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE run_id = ?").get(runId) as { n: number }).n);
  }

  // ---------------------------------------------------------------- events

  addEvent(runId: string, sessionId: string, type: string, data: unknown): EventRow {
    const t = now();
    const res = this.db
      .prepare("INSERT INTO events (run_id, session_id, type, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, sessionId, type, JSON.stringify(data ?? {}), t);
    return { id: Number(res.lastInsertRowid), run_id: runId, session_id: sessionId, type, data: JSON.stringify(data ?? {}), created_at: t };
  }

  listEvents(filter: { runId?: string; sessionId?: string; afterId?: number }): EventRow[] {
    if (filter.runId) {
      return this.db.prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id").all(filter.runId, filter.afterId ?? 0) as unknown as EventRow[];
    }
    return this.db
      .prepare("SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id")
      .all(filter.sessionId ?? "", filter.afterId ?? 0) as unknown as EventRow[];
  }

  close() {
    this.db.close();
  }
}

function rowToMessage(r: any): ChatMessage {
  if (r.role === "user") return { role: "user", content: r.content };
  if (r.role === "tool") return { role: "tool", toolCallId: r.tool_call_id, toolName: r.tool_name, content: r.content };
  const msg: ChatMessage = { role: "assistant", content: r.content };
  if (r.tool_calls) msg.toolCalls = JSON.parse(r.tool_calls) as ToolCall[];
  if (r.provider) msg.provider = r.provider;
  if (r.model) msg.model = r.model;
  return msg;
}
