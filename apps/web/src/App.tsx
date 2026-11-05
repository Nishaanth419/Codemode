import { Braces, FileBarChart, Globe, Menu, PanelRight, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatTimeline, Composer } from "./components/chat";
import { Inspector } from "./components/inspector";
import { ProviderStatusBar } from "./components/provider-status";
import { Sidebar } from "./components/sidebar";
import { ScrollArea } from "./components/ui/scroll-area";
import { TooltipProvider } from "./components/ui/tooltip";
import { useSessionStream, useSystemStatus } from "./hooks/use-agent";
import { api } from "./lib/api";
import type { ChatItem } from "./lib/timeline";
import type { Execution, Session, ToolNamespace } from "./lib/types";

const EXAMPLES = [
  {
    icon: Braces,
    title: "Compute & export",
    prompt: "Generate the first 20 prime numbers with Python, save them with their squares to primes.csv, then use a shell one-liner to report the sum of the squares."
  },
  {
    icon: FileBarChart,
    title: "Data analysis",
    prompt: "Install numpy and matplotlib, simulate 10,000 rolls of two dice, plot the distribution of sums to dice.png, and tell me the most common sum."
  },
  {
    icon: Globe,
    title: "Fetch from the web",
    prompt: "Fetch the top 5 Hacker News stories from the official HN Firebase API and write a short markdown digest to hn.md."
  },
  {
    icon: Wrench,
    title: "Inspect the sandbox",
    prompt: "List the tools you can use, then report the Python, Node.js and bash versions inside the sandbox in one program."
  }
];

function readHash() {
  const m = window.location.hash.match(/session=([\w-]+)/);
  return m ? m[1] : null;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readHash());
  const [tools, setTools] = useState<ToolNamespace[]>([]);
  const [history, setHistory] = useState<Execution[]>([]);
  const [selectedExec, setSelectedExec] = useState<string | null>(null);
  const [tab, setTab] = useState("timeline");
  const [draft, setDraft] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const { status, setStatus, error: statusError } = useSystemStatus();
  const { timeline } = useSessionStream(activeId, setStatus);

  const loadSessions = useCallback(() => api.sessions().then((r) => setSessions(r.sessions)).catch(() => {}), []);
  useEffect(() => {
    loadSessions();
    api.tools().then((r) => setTools(r.namespaces)).catch(() => {});
  }, [loadSessions]);

  useEffect(() => {
    window.location.hash = activeId ? `session=${activeId}` : "";
    setSelectedExec(null);
    if (!activeId) return setHistory([]);
    api.session(activeId).then((r) => setHistory(r.executions)).catch(() => setHistory([]));
  }, [activeId]);

  // Refresh history / artifacts / session list when executions or runs finish.
  const lastType = timeline.events[timeline.events.length - 1]?.type;
  useEffect(() => {
    if (!activeId || !lastType) return;
    if (["execution.completed", "execution.failed", "run.completed", "run.failed", "run.cancelled"].includes(lastType)) {
      api.session(activeId).then((r) => setHistory(r.executions)).catch(() => {});
      setRefreshKey((k) => k + 1);
      if (lastType.startsWith("run.")) loadSessions();
    }
    if (lastType === "execution.started") {
      setSelectedExec(null);
    }
  }, [lastType, activeId, loadSessions, timeline.events.length]);

  const executions = useMemo(() => timeline.items.filter((i): i is Extract<ChatItem, { kind: "execution" }> => i.kind === "execution"), [timeline.items]);

  const send = async (text: string) => {
    setSendError(null);
    try {
      let id = activeId;
      if (!id) {
        const s = await api.createSession();
        id = s.id;
        setActiveId(id);
        await new Promise((r) => setTimeout(r, 120)); // let the SSE stream attach first
      }
      await api.send(id, text);
      loadSessions();
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const stop = () => {
    if (timeline.activeRunId) api.cancel(timeline.activeRunId).catch(() => {});
  };

  const current = status?.llm.providers.find((p) => p.name === status.llm.currentProvider);
  const activeSession = sessions.find((s) => s.id === activeId);
  const noProviders = status && !status.llm.providers.some((p) => p.configured);

  return (
    <TooltipProvider>
      <div className="flex h-full overflow-hidden">
        {(sidebarOpen || inspectorOpen) && (
          <div className="fixed inset-0 z-30 bg-black/60 xl:hidden" onClick={() => { setSidebarOpen(false); setInspectorOpen(false); }} />
        )}
        <div className={`fixed inset-y-0 left-0 z-40 transition-transform lg:static lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <Sidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setSidebarOpen(false);
          }}
          onNew={() => {
            setActiveId(null);
            setDraft("");
            setSidebarOpen(false);
          }}
          onDelete={async (id) => {
            await api.deleteSession(id).catch(() => {});
            if (id === activeId) setActiveId(null);
            loadSessions();
          }}
          tools={tools}
          status={status}
          onInsertTool={(name) => setDraft((d) => (d ? `${d} ${name}` : `Use ${name} to `))}
        />
        </div>

        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="bg-grid pointer-events-none absolute inset-0" />
          <header className="relative z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-obsidian/80 px-5 backdrop-blur">
            <button className="-ml-1 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-paper lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              <Menu className="size-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{activeSession?.title ?? "New session"}</div>
              <div className="font-mono text-[10px] text-faint">
                {timeline.running ? (
                  <span className="text-lime">● running</span>
                ) : timeline.lastProvider ? (
                  `last answer by ${timeline.lastProvider} · ${timeline.lastModel}`
                ) : (
                  "idle"
                )}
              </div>
            </div>
            <ProviderStatusBar status={status} />
            <button className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-paper xl:hidden" onClick={() => setInspectorOpen(true)} aria-label="Open inspector">
              <PanelRight className="size-4" />
            </button>
          </header>

          <ScrollArea className="relative z-10 min-h-0 flex-1">
            {timeline.items.length === 0 ? (
              <EmptyState onPick={(p) => setDraft(p)} />
            ) : (
              <ChatTimeline
                items={timeline.items}
                running={timeline.running}
                selectedExecution={selectedExec}
                onInspect={(id) => {
                  setSelectedExec(id);
                  setTab("code");
                  setInspectorOpen(true);
                }}
              />
            )}
          </ScrollArea>

          <div className="relative z-10">
            {(sendError || statusError || noProviders) && (
              <div className="mx-auto mb-2 max-w-3xl px-6">
                <div className="rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-2 text-xs text-danger">
                  {sendError ??
                    (statusError
                      ? `Cannot reach the agent backend (${statusError}). Is it running on port 8787?`
                      : "No LLM provider is configured. Set GROQ_API_KEY and/or GEMINI_API_KEY in .env on the server, then restart the agent.")}
                </div>
              </div>
            )}
            <Composer
              running={timeline.running}
              onSend={send}
              onStop={stop}
              draft={draft}
              setDraft={setDraft}
              hint={
                <span>
                  <kbd className="font-mono">Enter</kbd> to send ·{" "}
                  {current ? (
                    <>
                      next request → <span className="text-muted">{current.label}</span> <span className="font-mono">{current.model}</span>
                    </>
                  ) : (
                    <span className="text-danger">no provider available</span>
                  )}
                </span>
              }
            />
          </div>
        </main>

        <div className={`fixed inset-y-0 right-0 z-40 max-w-[92vw] transition-transform xl:static xl:translate-x-0 ${inspectorOpen ? "translate-x-0" : "translate-x-full"}`}>
        <Inspector
          sessionId={activeId}
          tab={tab}
          setTab={setTab}
          executions={executions}
          selectedId={selectedExec}
          onSelect={setSelectedExec}
          events={timeline.events}
          history={history}
          refreshKey={refreshKey}
        />
        </div>
      </div>
    </TooltipProvider>
  );
}

function EmptyState({ onPick }: { onPick: (p: string) => void }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col px-6 pb-10 pt-[12vh]">
      <div className="mb-3 inline-flex w-fit items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 font-mono text-[11px] text-muted">
        <span className="size-1.5 rounded-full bg-lime shadow-[0_0_8px] shadow-lime" /> Code Mode · one program, many tools
      </div>
      <h1 className="text-[34px] font-semibold leading-[1.1] tracking-tight">
        Describe the task.
        <br />
        <span className="text-lime">AgentOS writes the code and runs it.</span>
      </h1>
      <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
        The model writes one JavaScript program against typed tool APIs. It runs in an isolated executor, calls Python, Node.js and shell in Docker, and every step is traced on the right.
      </p>
      <div className="mt-9 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.title}
            onClick={() => onPick(ex.prompt)}
            className="group rounded-xl border border-line bg-surface/60 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-lime/35 hover:bg-surface cursor-pointer"
          >
            <ex.icon className="mb-3 size-4 text-faint transition-colors group-hover:text-lime" />
            <div className="text-sm font-medium">{ex.title}</div>
            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-faint">{ex.prompt}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
