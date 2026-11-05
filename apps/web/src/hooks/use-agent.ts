import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "@/lib/api";
import { applyEvent, initialTimeline, type TimelineState } from "@/lib/timeline";
import type { AgentEvent, SystemStatus } from "@/lib/types";

type Action = { type: "event"; event: AgentEvent } | { type: "reset" };

function reducer(state: TimelineState, action: Action): TimelineState {
  if (action.type === "reset") return initialTimeline;
  return applyEvent(state, action.event);
}

/** Subscribes to a session's SSE stream: replays persisted events, then follows live ones. */
export function useSessionStream(sessionId: string | null, onStatus: (s: SystemStatus) => void) {
  const [timeline, dispatch] = useReducer(reducer, initialTimeline);
  const [connected, setConnected] = useState(false);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    dispatch({ type: "reset" });
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/events`);
    es.addEventListener("open", () => setConnected(true));
    es.addEventListener("error", () => setConnected(false));
    es.addEventListener("agent", (msg) => dispatch({ type: "event", event: JSON.parse((msg as MessageEvent).data) }));
    es.addEventListener("status", (msg) => statusRef.current(JSON.parse((msg as MessageEvent).data)));
    return () => {
      es.close();
      setConnected(false);
    };
  }, [sessionId]);

  return { timeline, connected };
}

/** System status (providers, executor, sandbox): pushed over SSE, polled as a fallback. */
export function useSystemStatus() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api
      .status()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);
  return { status, setStatus, error, refresh };
}

/** Re-renders every second while mounted (for countdowns). */
export function useNow(active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
