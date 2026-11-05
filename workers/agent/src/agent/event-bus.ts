/**
 * Execution event bus. Persistent events are stored in SQLite (so execution history
 * can be replayed) and pushed to live SSE subscribers. High-frequency events such as
 * streamed text deltas are ephemeral: pushed live, not stored.
 */
import { EventEmitter } from "node:events";
import type { AppDatabase } from "../db/database.js";

export interface AgentEvent {
  id: number | null;
  runId: string;
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly db: AppDatabase) {
    this.emitter.setMaxListeners(200);
  }

  publish(runId: string, sessionId: string, type: string, data: Record<string, unknown> = {}, opts: { persist?: boolean } = {}): AgentEvent {
    const persist = opts.persist ?? true;
    let event: AgentEvent;
    if (persist) {
      const row = this.db.addEvent(runId, sessionId, type, data);
      event = { id: row.id, runId, sessionId, type, data, createdAt: row.created_at };
    } else {
      event = { id: null, runId, sessionId, type, data, createdAt: new Date().toISOString() };
    }
    this.emitter.emit(`session:${sessionId}`, event);
    this.emitter.emit("*", event);
    return event;
  }

  subscribe(sessionId: string, fn: (e: AgentEvent) => void): () => void {
    const key = `session:${sessionId}`;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }

  subscribeAll(fn: (e: AgentEvent) => void): () => void {
    this.emitter.on("*", fn);
    return () => this.emitter.off("*", fn);
  }
}

export function rowToEvent(r: { id: number; run_id: string; session_id: string; type: string; data: string; created_at: string }): AgentEvent {
  return { id: r.id, runId: r.run_id, sessionId: r.session_id, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at };
}
