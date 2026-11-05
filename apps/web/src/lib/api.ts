import type { Execution, Session, SystemStatus, ToolNamespace, WorkspaceFile } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  status: () => req<SystemStatus>("/api/status"),
  tools: () => req<{ namespaces: ToolNamespace[]; allowedPackages: { manager: string; name: string }[] }>("/api/tools"),
  sessions: () => req<{ sessions: Session[] }>("/api/sessions"),
  createSession: () => req<Session>("/api/sessions", { method: "POST", body: "{}" }),
  deleteSession: (id: string) => req<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  session: (id: string) => req<{ session: Session; executions: Execution[]; busy: boolean }>(`/api/sessions/${id}`),
  send: (id: string, content: string) => req<{ runId: string }>(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  cancel: (runId: string) => req<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`, { method: "POST" }),
  files: (id: string) => req<{ files: WorkspaceFile[] }>(`/api/sessions/${id}/files`),
  fileContent: (id: string, path: string) =>
    req<{ content: string; truncated: boolean; size: number }>(`/api/sessions/${id}/files/content?path=${encodeURIComponent(path)}`),
  downloadUrl: (id: string, path: string) => `/api/sessions/${id}/files/download?path=${encodeURIComponent(path)}`
};
