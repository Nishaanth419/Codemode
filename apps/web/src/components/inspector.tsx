import {
  Activity,
  ArrowRightLeft,
  Check,
  Code2,
  Download,
  FileText,
  FolderOpen,
  History as HistoryIcon,
  Loader2,
  RefreshCw,
  SquareTerminal,
  X
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type { ChatItem } from "@/lib/timeline";
import type { AgentEvent, Execution, WorkspaceFile } from "@/lib/types";
import { clock, cn, formatBytes, formatDuration, timeAgo } from "@/lib/utils";
import { ModelTag } from "./chat";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const CodeViewer = lazy(() => import("./code-viewer").then((m) => ({ default: m.CodeViewer })));

type ExecItem = Extract<ChatItem, { kind: "execution" }>;

export function Inspector(props: {
  sessionId: string | null;
  tab: string;
  setTab: (t: string) => void;
  executions: ExecItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  events: AgentEvent[];
  history: Execution[];
  refreshKey: number;
}) {
  const selected = props.executions.find((e) => e.id === props.selectedId) ?? props.executions[props.executions.length - 1];

  return (
    <aside className="flex h-full w-[460px] max-w-full shrink-0 flex-col border-l border-line bg-obsidian-950 xl:bg-obsidian-950/60">
      <Tabs value={props.tab} onValueChange={props.setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="h-14 shrink-0">
          <TabsTrigger value="timeline">
            <Activity /> Timeline
          </TabsTrigger>
          <TabsTrigger value="code">
            <Code2 /> Code
          </TabsTrigger>
          <TabsTrigger value="terminal">
            <SquareTerminal /> Terminal
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            <FolderOpen /> Artifacts
          </TabsTrigger>
          <TabsTrigger value="history">
            <HistoryIcon /> History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="flex flex-col">
          <EventTimeline events={props.events} />
        </TabsContent>

        <TabsContent value="code" className="flex flex-col">
          {selected ? (
            <>
              <ExecutionHeader e={selected} executions={props.executions} onSelect={props.onSelect} />
              <div className="min-h-0 flex-1">
                <Suspense fallback={<div className="p-4 font-mono text-xs text-faint">Loading editor…</div>}>
                  <CodeViewer value={selected.code} path={`${selected.id}.js`} />
                </Suspense>
              </div>
              {(selected.result !== undefined || selected.error) && (
                <div className="max-h-48 shrink-0 overflow-auto border-t border-line bg-obsidian-950 px-4 py-3 font-mono text-[11.5px]">
                  <div className="mb-1 text-[10px] uppercase tracking-widest text-faint">{selected.error ? "Error" : "Return value"}</div>
                  <pre className={cn("whitespace-pre-wrap", selected.error ? "text-danger" : "text-lime/90")}>
                    {selected.error ?? JSON.stringify(selected.result, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <Empty icon={Code2} text="Generated programs appear here once the agent runs code." />
          )}
        </TabsContent>

        <TabsContent value="terminal" className="flex flex-col">
          <Terminal executions={props.executions} />
        </TabsContent>

        <TabsContent value="artifacts" className="flex flex-col">
          <Artifacts sessionId={props.sessionId} refreshKey={props.refreshKey} />
        </TabsContent>

        <TabsContent value="history" className="flex flex-col">
          <HistoryList
            items={props.history}
            onSelect={(id) => {
              props.onSelect(id);
              props.setTab("code");
            }}
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function ExecutionHeader({ e, executions, onSelect }: { e: ExecItem; executions: ExecItem[]; onSelect: (id: string) => void }) {
  const idx = executions.findIndex((x) => x.id === e.id);
  return (
    <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <StatusIcon status={e.status} />
        <span className="font-mono text-xs text-paper">{e.id}</span>
        <Badge variant={e.status === "failed" ? "danger" : e.status === "running" ? "lime" : "outline"}>{e.status}</Badge>
        {e.durationMs !== undefined && <span className="font-mono text-[11px] text-faint">{formatDuration(e.durationMs)}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={idx <= 0} onClick={() => onSelect(executions[idx - 1].id)} aria-label="Previous">
            ‹
          </Button>
          <span className="font-mono text-[10px] text-faint">
            {idx + 1}/{executions.length}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={idx >= executions.length - 1} onClick={() => onSelect(executions[idx + 1].id)} aria-label="Next">
            ›
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ModelTag provider={e.provider} model={e.model} />
        <span className="font-mono text-[10px] text-faint">{e.executor}</span>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 className="size-3.5 animate-spin text-lime" />;
  if (status === "failed") return <X className="size-3.5 text-danger" />;
  return <Check className="size-3.5 text-lime" />;
}

const EVENT_STYLE: Record<string, string> = {
  "provider.failover": "text-warn",
  "provider.retry": "text-warn/80",
  "provider.skipped": "text-warn/70",
  "provider.error": "text-danger",
  "provider.stream_reset": "text-warn/80",
  "run.failed": "text-danger",
  "run.cancelled": "text-warn",
  "run.completed": "text-lime",
  "execution.completed": "text-lime/90",
  "execution.failed": "text-danger",
  "execution.deduplicated": "text-info",
  "assistant.discarded": "text-warn"
};

function describe(e: AgentEvent): string {
  const d = e.data;
  switch (e.type) {
    case "run.started":
      return `Run started · ${d.chain?.map((c: { provider: string }) => c.provider).join(" → ") || "no providers"}`;
    case "llm.request":
      return `LLM step ${d.step} (${d.messages} messages)`;
    case "provider.request":
      return `${d.provider} · ${d.model}${d.attempt > 1 ? ` · attempt ${d.attempt}` : ""}`;
    case "provider.response":
      return `${d.provider} responded in ${formatDuration(d.latencyMs)}${d.usage?.totalTokens ? ` · ${d.usage.totalTokens} tokens` : ""}`;
    case "provider.retry":
      return `${d.reason} · retry in ${formatDuration(d.delayMs)}`;
    case "provider.failover":
      return d.message;
    case "provider.skipped":
      return `${d.reason}; still using ${d.to}`;
    case "provider.error":
      return `${d.error?.summary ?? "error"}${d.willFailover ? " → failing over" : ""}`;
    case "provider.stream_reset":
      return `${d.provider} stream interrupted: ${d.reason}`;
    case "assistant.message":
      return `${d.providerLabel ?? d.provider} · ${d.model}${d.toolCalls?.length ? ` · ${d.toolCalls.length} tool call` : " · answer"}`;
    case "assistant.discarded":
      return d.reason;
    case "execution.started":
      return `Executing program on ${d.executorLabel}`;
    case "tool.call":
      return `${d.namespace}.${d.tool}()`;
    case "tool.result":
      return `${d.namespace}.${d.tool} ${d.ok ? "ok" : "failed"} · ${formatDuration(d.durationMs)}${d.error ? ` · ${d.error}` : ""}`;
    case "execution.log":
      return d.line;
    case "execution.output":
      return `[${d.source}:${d.stream}] ${String(d.chunk).trim().slice(0, 140)}`;
    case "execution.completed":
      return `Completed in ${formatDuration(d.durationMs)}`;
    case "execution.failed":
      return `Failed: ${d.error}`;
    case "execution.deduplicated":
      return d.reason;
    case "run.completed":
      return `Run completed on ${d.provider} · ${d.model}`;
    case "run.failed":
      return d.message;
    default:
      return e.type;
  }
}

function EventTimeline({ events }: { events: AgentEvent[] }) {
  const shown = events.filter((e) => e.type !== "execution.log" || events.length < 400);
  if (!shown.length) return <Empty icon={Activity} text="Execution events stream here in real time: provider calls, failovers, tool calls and results." />;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ol className="relative px-4 py-3">
        <div className="absolute bottom-3 left-[23px] top-3 w-px bg-line" />
        {shown.map((e, i) => {
          const failover = e.type === "provider.failover";
          return (
            <li key={e.id ?? `x${i}`} className={cn("relative flex gap-3 py-1", failover && "my-1.5")}>
              <span
                className={cn(
                  "relative z-10 mt-1.5 size-[9px] shrink-0 rounded-full border-2 border-obsidian-950",
                  failover ? "bg-warn" : e.type.startsWith("run.") ? "bg-lime" : e.type.startsWith("execution") || e.type.startsWith("tool") ? "bg-paper/60" : "bg-line-strong"
                )}
              />
              <div className={cn("min-w-0 flex-1", failover && "rounded-lg border border-warn/30 bg-warn/[0.06] px-2.5 py-1.5")}>
                <div className="flex items-baseline gap-2">
                  <span className={cn("font-mono text-[10.5px]", EVENT_STYLE[e.type] ?? "text-faint")}>
                    {failover && <ArrowRightLeft className="mr-1 inline size-3" />}
                    {e.type}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">{clock(e.createdAt)}</span>
                </div>
                <div className={cn("break-words text-[12px] leading-snug", failover ? "font-medium text-warn" : "text-muted")}>{describe(e)}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </ScrollArea>
  );
}

function Terminal({ executions }: { executions: ExecItem[] }) {
  const lines = useMemo(
    () =>
      executions.flatMap((e) => [
        { cls: "text-lime", text: `$ codemode run ${e.id}  # ${e.provider}/${e.model}` },
        ...e.output.flatMap((o) =>
          o.text
            .replace(/\n$/, "")
            .split("\n")
            .map((t) => ({
              cls: o.stream === "stderr" ? "text-danger/90" : o.stream === "log" ? "text-paper/85" : "text-info/90",
              text: o.stream === "log" ? t : `[${o.source}] ${t}`
            }))
        ),
        ...(e.status === "running"
          ? [{ cls: "text-faint", text: "… running" }]
          : e.error
            ? [{ cls: "text-danger", text: `✕ ${e.error}` }]
            : [{ cls: "text-faint", text: `✓ exit 0 · ${formatDuration(e.durationMs)}` }]),
        { cls: "", text: "" }
      ]),
    [executions]
  );
  if (!executions.length) return <Empty icon={SquareTerminal} text="Console output and sandbox stdout/stderr appear here live." />;
  return (
    <ScrollArea className="min-h-0 flex-1 bg-obsidian-950">
      <pre className="px-4 py-3 font-mono text-[11.5px] leading-[1.6]">
        {lines.map((l, i) => (
          <div key={i} className={cn("whitespace-pre-wrap break-all", l.cls)}>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </ScrollArea>
  );
}

function Artifacts({ sessionId, refreshKey }: { sessionId: string | null; refreshKey: number }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    if (!sessionId) return;
    setLoading(true);
    api
      .files(sessionId)
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setPreview(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refreshKey]);

  if (!sessionId) return <Empty icon={FolderOpen} text="Start a session to create artifacts." />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-faint">/workspace · {files.length} files</span>
        <Button variant="ghost" size="icon-sm" onClick={load} aria-label="Refresh">
          <RefreshCw className={cn("!size-3.5", loading && "animate-spin")} />
        </Button>
      </div>
      {files.length === 0 ? (
        <Empty icon={FileText} text="Files written by fs.writeFile or by sandbox programs in /workspace show up here." />
      ) : (
        <ScrollArea className={cn("min-h-0", preview ? "max-h-[40%]" : "flex-1")}>
          <div className="space-y-0.5 px-2 pb-2">
            {files.map((f) => (
              <div
                key={f.path}
                onClick={() => api.fileContent(sessionId, f.path).then((r) => setPreview({ path: f.path, content: r.content }))}
                className={cn(
                  "group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-surface",
                  preview?.path === f.path && "bg-surface ring-1 ring-inset ring-line"
                )}
              >
                <FileText className="size-4 shrink-0 text-lime/80" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-paper">{f.path}</div>
                  <div className="font-mono text-[10px] text-faint">
                    {formatBytes(f.size)} · {timeAgo(f.modifiedAt)}
                  </div>
                </div>
                <a
                  href={api.downloadUrl(sessionId, f.path)}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-md p-1.5 text-faint hover:bg-surface-3 hover:text-lime"
                  aria-label={`Download ${f.path}`}
                >
                  <Download className="size-3.5" />
                </a>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
      {preview && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line">
          <div className="px-4 py-2 font-mono text-[11px] text-muted">{preview.path}</div>
          <div className="min-h-0 flex-1">
            <Suspense fallback={null}>
              <CodeViewer value={preview.content} path={`artifact/${preview.path}`} language={languageFor(preview.path)} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

function languageFor(p: string) {
  const ext = p.split(".").pop()?.toLowerCase();
  return (
    { js: "javascript", mjs: "javascript", ts: "typescript", py: "python", json: "json", md: "markdown", csv: "plaintext", html: "html", css: "css", sh: "shell", yml: "yaml", yaml: "yaml" }[
      ext ?? ""
    ] ?? "plaintext"
  );
}

function HistoryList({ items, onSelect }: { items: Execution[]; onSelect: (id: string) => void }) {
  if (!items.length) return <Empty icon={HistoryIcon} text="Every executed program is recorded with the provider and model that wrote it." />;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="divide-y divide-line">
        {items.map((e) => (
          <button key={e.id} onClick={() => onSelect(e.id)} className="block w-full px-4 py-3 text-left hover:bg-surface/70 cursor-pointer">
            <div className="flex items-center gap-2">
              <StatusIcon status={e.status} />
              <span className="font-mono text-[11px] text-paper">{e.id}</span>
              <span className="ml-auto font-mono text-[10px] text-faint">{timeAgo(e.startedAt)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <ModelTag provider={e.provider} model={e.model} />
              <span className="font-mono text-[10px] text-faint">{formatDuration(e.durationMs)}</span>
              <span className="font-mono text-[10px] text-faint">{e.toolCalls.length} tool calls</span>
            </div>
            <pre className="mt-1.5 truncate font-mono text-[11px] text-faint">{e.code.replace(/\s+/g, " ").slice(0, 120)}</pre>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

function Empty({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-10 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-surface ring-1 ring-inset ring-line">
        <Icon className="size-4 text-faint" />
      </div>
      <p className="max-w-[260px] text-xs leading-relaxed text-faint">{text}</p>
    </div>
  );
}
