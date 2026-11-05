/**
 * "How it works" page: a guided, replayable walkthrough of one AgentOS run.
 *
 * Everything here is scripted from the real system design (no backend calls), so the
 * demo works even when no LLM provider is configured. Each step lights up the component
 * that is doing the work and shows the actual payload that crosses that boundary.
 */
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Container,
  Cpu,
  Database,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Route,
  ShieldCheck,
  Sparkles,
  Workflow,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Logo } from "./sidebar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

/** sessionStorage key used to hand a prompt from this page to the workspace composer. */
export const DRAFT_KEY = "agentos.draft";

export const DEMO_PROMPT =
  "Generate the first 20 prime numbers with Python, save them with their squares to primes.csv, then use a shell one-liner to report the sum of the squares.";

const PROGRAM = `async () => {
  const py = await sandbox.runPython({ code: \`
import csv
primes, n = [], 2
while len(primes) < 20:
    if all(n % p for p in primes): primes.append(n)
    n += 1
with open("primes.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["prime", "square"])
    w.writerows([p, p * p] for p in primes)
print(len(primes))
\` });
  console.log("python wrote", py.stdout.trim(), "rows");

  const sh = await sandbox.runShell({
    command: "awk -F, 'NR>1 {s+=$2} END {print s}' primes.csv"
  });

  return {
    rows: Number(py.stdout.trim()),
    sumOfSquares: Number(sh.stdout.trim()),
    file: "primes.csv"
  };
}`;

/* ------------------------------------------------------------------ */
/* Architecture nodes                                                   */
/* ------------------------------------------------------------------ */

type NodeId = "ui" | "agent" | "router" | "llm" | "codemode" | "executor" | "tools" | "docker" | "store";

const NODES: Record<NodeId, { label: string; sub: string; icon: ComponentType<{ className?: string }>; file: string }> = {
  ui: { label: "Web workspace", sub: "React · SSE client", icon: Monitor, file: "apps/web" },
  agent: { label: "Agent runner", sub: "the agent loop", icon: Workflow, file: "agent/agent-runner.ts" },
  router: { label: "Provider router", sub: "retry · failover · health", icon: Route, file: "providers/provider-router.ts" },
  llm: { label: "LLM", sub: "Groq → Gemini → Ollama", icon: Sparkles, file: "providers/*-provider.ts" },
  codemode: { label: "Code Mode", sub: "types · normalize · runCode", icon: Boxes, file: "codemode/code-tool.ts" },
  executor: { label: "Executor", sub: "isolated V8 / container", icon: Cpu, file: "codemode/executors.ts" },
  tools: { label: "Host tools", sub: "fs · sandbox · web", icon: Zap, file: "tools/registry.ts" },
  docker: { label: "Docker sandbox", sub: "no network · read-only", icon: Container, file: "sandbox/docker.ts" },
  store: { label: "SQLite + event bus", sub: "history · events · replay", icon: Database, file: "db/database.ts" }
};

/* ------------------------------------------------------------------ */
/* Scripted run                                                         */
/* ------------------------------------------------------------------ */

type Panel = { label: string; lang: "js" | "json" | "text" | "md"; content: string };

interface Step {
  id: string;
  active: NodeId[];
  title: string;
  body: ReactNode;
  panel: Panel;
  event?: string;
  tone?: "warn";
  failoverOnly?: boolean;
  normalOnly?: boolean;
}

const STEPS: Step[] = [
  {
    id: "send",
    active: ["ui", "agent"],
    title: "You describe the task",
    body: (
      <>
        The browser posts your message and immediately gets a <code>runId</code> back. It already has an SSE stream open on the session, so every
        step below arrives live.
      </>
    ),
    event: "run.started",
    panel: {
      label: "POST /api/sessions/:id/messages",
      lang: "json",
      content: JSON.stringify({ content: DEMO_PROMPT }, null, 2) + "\n\n// → 202 Accepted\n" + JSON.stringify({ runId: "run_8f3c1a…", sessionId: "…" }, null, 2)
    }
  },
  {
    id: "prompt",
    active: ["agent", "codemode"],
    title: "The model is given exactly one tool",
    body: (
      <>
        Instead of exposing a dozen tools, Code Mode turns every tool namespace into <strong>TypeScript declarations</strong> and hands the model a
        single tool, <code>codemode</code>, whose only input is <code>{"{ code }"}</code>. LLMs are far better at writing code against an API than at
        emitting long chains of JSON tool calls.
      </>
    ),
    panel: {
      label: "tools[0] sent to the LLM (generated)",
      lang: "js",
      content: `// name: "codemode"   input: { code: string }
// "Execute JavaScript to achieve a goal. These APIs are globals:"

/** Run code in an isolated Docker container ... */
declare const sandbox: {
  runPython(input: { code: string; timeoutMs?: number }):
    Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  runNode(input: { code: string; timeoutMs?: number }): Promise<...>;
  runShell(input: { command: string; timeoutMs?: number }): Promise<...>;
  installPackage(input: { manager: "pip" | "npm"; name: string }): Promise<...>;
};
declare const fs: { listFiles(...); readFile(...); writeFile(...); deleteFile(...) };
declare const web: { fetch(input: { url: string; ... }): Promise<...> };
declare const codemode: { searchTools(input: { query: string }): Promise<...> };`
    }
  },
  {
    id: "route",
    active: ["agent", "router", "llm"],
    title: "The router picks a provider",
    normalOnly: true,
    body: (
      <>
        The same system prompt, full conversation history and <code>codemode</code> tool go to the first healthy provider in the chain. The
        router only talks to models; it never runs code.
      </>
    ),
    event: "llm.request",
    panel: {
      label: "provider chain",
      lang: "json",
      content: JSON.stringify(
        [
          { provider: "groq", model: "openai/gpt-oss-120b", status: "active" },
          { provider: "gemini", model: "gemini-3.6-flash", status: "standby" }
        ],
        null,
        2
      )
    }
  },
  {
    id: "route-fail",
    active: ["router", "llm"],
    title: "Groq hits its rate limit",
    failoverOnly: true,
    tone: "warn",
    body: (
      <>
        Groq answers <code>429</code> with a daily-quota message. <code>errors.ts</code> classifies it as <code>quota_exhausted</code>, and{" "}
        <code>retry-policy.ts</code> decides that retrying the same provider is pointless, so the router <strong>fails over</strong>. Groq is skipped
        until its retry-after time.
      </>
    ),
    event: "provider.failover",
    panel: {
      label: "router events",
      lang: "json",
      content: `{ "type": "provider.error", "provider": "groq", "willFailover": true,
  "error": { "kind": "quota_exhausted", "status": 429, ... } }

{ "type": "provider.failover", "from": "groq", "to": "gemini",
  "message": "Groq daily quota exhausted. Switching to Gemini.",
  "retryAt": "2026-11-06T00:00:00Z" }`
    }
  },
  {
    id: "route-gemini",
    active: ["router", "llm"],
    title: "Gemini picks up the same conversation",
    failoverOnly: true,
    body: (
      <>
        Gemini receives the <em>identical</em> system prompt, history and tool. Wire formats are translated per provider, so the agent does not
        notice the switch. Nothing was executed yet, so nothing can run twice.
      </>
    ),
    event: "llm.request",
    panel: {
      label: "provider chain",
      lang: "json",
      content: JSON.stringify(
        [
          { provider: "groq", model: "openai/gpt-oss-120b", status: "rate_limited", retryIn: "57m" },
          { provider: "gemini", model: "gemini-3.6-flash", status: "active" }
        ],
        null,
        2
      )
    }
  },
  {
    id: "program",
    active: ["llm", "agent"],
    title: "The model writes one program",
    body: (
      <>
        The model replies with a single <code>codemode</code> tool call. The program chains two sandbox calls, a console log and a return value.
        Classic tool calling would need a model round trip per tool call; here the model is called once.
      </>
    ),
    event: "assistant.message",
    panel: { label: "codemode({ code })", lang: "js", content: PROGRAM }
  },
  {
    id: "execute",
    active: ["codemode", "executor"],
    title: "The program runs in an isolated executor",
    body: (
      <>
        <code>runCode</code> from <code>@cloudflare/codemode</code> normalizes the code and hands it to an <code>Executor</code>. By default it runs
        in a fresh V8 context inside a worker thread: no <code>require</code>, <code>process</code>, <code>fetch</code> or <code>eval</code>, a heap
        limit and a hard timeout. Set <code>CODEMODE_EXECUTOR=docker</code> to run it in a locked-down container instead.
      </>
    ),
    event: "execution.started",
    panel: {
      label: "executor",
      lang: "text",
      content: `executor     local-worker   (or: docker)
isolation    fresh V8 context, empty globals
disabled     require · import · process · fetch · eval · WebAssembly
limits       heap 128 MB · wall clock 30 s   (CODEMODE_MEMORY_MB / _TIMEOUT_MS)
boundary     only JSON strings cross it

the program can see:  sandbox.*  fs.*  web.*  codemode.*  console`
    }
  },
  {
    id: "tool-call",
    active: ["executor", "tools", "docker"],
    title: "Tool calls are forwarded to the host",
    body: (
      <>
        <code>sandbox.runPython(...)</code> inside the program is just a stub. It sends a JSON message to the host, which runs the real tool:
        here, Python in a throwaway Docker container with the session workspace mounted.
      </>
    ),
    event: "tool.call",
    panel: {
      label: "runtime → host",
      lang: "json",
      content: `{ "type": "tool-call", "id": "c1",
  "namespace": "sandbox", "name": "runPython",
  "args": "{\\"code\\":\\"import csv\\\\nprimes, n = ...\\"}" }

$ docker run --rm --network none --read-only --cap-drop ALL \\
    --security-opt no-new-privileges --memory 256m --cpus 0.5 --pids-limit 64 \\
    -v <session-workspace>:/workspace agentos-sandbox python3 -

stdout: 20`
    }
  },
  {
    id: "tool-call-2",
    active: ["executor", "tools", "docker"],
    title: "…and the program keeps going",
    body: (
      <>
        The result comes back into the program as a normal value. It logs progress and calls <code>sandbox.runShell</code> on the CSV that Python
        just wrote. Loops, conditionals and <code>Promise.all</code> all work, without involving the model.
      </>
    ),
    event: "tool.result",
    panel: {
      label: "console + second call",
      lang: "text",
      content: `[log] python wrote 20 rows

sandbox.runShell  awk -F, 'NR>1 {s+=$2} END {print s}' primes.csv
stdout: 30007
exitCode: 0     duration: 184ms

workspace/primes.csv  (21 lines, shown in Artifacts)`
    }
  },
  {
    id: "result",
    active: ["executor", "agent", "store"],
    title: "One compact result goes back to the model",
    body: (
      <>
        The program's return value (truncated if large) becomes the tool result message. The execution is stored by <code>(run, tool call id)</code>{" "}
        and by code hash, so the same program is never executed twice, even if a provider switch makes the next model re-emit it.
      </>
    ),
    event: "execution.completed",
    panel: {
      label: "tool message (role: tool)",
      lang: "json",
      content: JSON.stringify(
        { ok: true, result: { rows: 20, sumOfSquares: 30007, file: "primes.csv" }, logs: ["python wrote 20 rows"], executionId: "exec_2b91…" },
        null,
        2
      )
    }
  },
  {
    id: "answer",
    active: ["llm", "agent", "ui"],
    title: "The model answers from real results",
    body: (
      <>
        A second LLM call sees the tool result and writes the final answer. The answer is tagged with the provider and model that wrote it, and the
        program, logs and files stay inspectable on the right.
      </>
    ),
    event: "run.completed",
    panel: {
      label: "assistant (markdown)",
      lang: "md",
      content: `I generated the first **20 primes** in Python and saved them with their
squares to \`primes.csv\`. A shell one-liner summed the squares:

**Sum of squares: 30,007**

Files: primes.csv`
    }
  },
  {
    id: "stream",
    active: ["store", "ui"],
    title: "Every step is persisted and streamed",
    body: (
      <>
        Messages, runs, executions and events live in SQLite. The SSE endpoint replays persisted events and then streams live ones, with{" "}
        <code>Last-Event-ID</code> support, so a reload never loses the timeline.
      </>
    ),
    panel: {
      label: "GET /api/sessions/:id/events",
      lang: "text",
      content: `run.started            chain: groq → gemini
llm.request            step 1
assistant.message      codemode × 1
execution.started      exec_2b91 · local-worker
tool.call / result     sandbox.runPython  ok  612ms
execution.log          python wrote 20 rows
tool.call / result     sandbox.runShell   ok  184ms
execution.completed    ok  1.1s
llm.request            step 2
assistant.message      final answer
run.completed          2 steps`
    }
  }
];

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export function HowItWorks({ onTry }: { onTry: (prompt: string) => void }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="bg-grid pointer-events-none fixed inset-0" />
      <div className="relative mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <nav className="flex h-16 items-center justify-between gap-3">
          <Logo />
          <a href="#" className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-paper">
            <ArrowLeft className="size-4" /> Back to workspace
          </a>
        </nav>

        <Hero onTry={onTry} />
        <Comparison />
        <Demo onTry={onTry} />
        <Layers />
        <Guarantees />
        <Closing onTry={onTry} />
      </div>
    </div>
  );
}

function Hero({ onTry }: { onTry: (p: string) => void }) {
  return (
    <section className="pb-14 pt-12 sm:pt-16">
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 font-mono text-[11px] text-muted">
        <span className="size-1.5 rounded-full bg-lime shadow-[0_0_8px] shadow-lime" /> How it works
      </div>
      <h1 className="max-w-3xl text-[34px] font-semibold leading-[1.08] tracking-tight sm:text-[46px]">
        The model writes <span className="text-lime">one program</span>.
        <br />
        AgentOS runs it safely.
      </h1>
      <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-muted sm:text-base">
        AgentOS uses the <strong className="text-paper">Code Mode</strong> pattern: instead of calling tools one at a time, the LLM writes a short
        JavaScript program against typed tool APIs. The program runs in an isolated executor, calls Python, Node.js and shell in a Docker sandbox, and
        every step streams to the UI.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={() => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth" })}>
          <Play /> Watch a run
        </Button>
        <Button variant="outline" onClick={() => onTry(DEMO_PROMPT)}>
          Try it yourself <ArrowRight />
        </Button>
      </div>
    </section>
  );
}

function SectionHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-7">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-lime-dim">{kicker}</div>
      <h2 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h2>
      {children && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted sm:text-[15px]">{children}</p>}
    </div>
  );
}

/* ---------- Classic tool calling vs Code Mode ---------- */

function Comparison() {
  const classic = [
    ["LLM", "call sandbox.runPython"],
    ["host", "→ stdout: 20"],
    ["LLM", "read result, call sandbox.runShell"],
    ["host", "→ stdout: 30007"],
    ["LLM", "write the answer"]
  ];
  return (
    <section className="py-14">
      <SectionHead kicker="01 · the idea" title="Why one program beats many tool calls">
        With classic tool calling, every tool call is a full model round trip, and every intermediate result passes back through the context window. In
        Code Mode the model writes the whole plan as code once, and intermediate values stay inside the program.
      </SectionHead>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface/60 p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="text-sm font-medium">Classic tool calling</div>
            <Badge variant="warn">3 LLM calls</Badge>
          </div>
          <ol className="space-y-2">
            {classic.map(([who, what], i) => (
              <li key={i} className="flex items-center gap-3 font-mono text-xs">
                <span className={cn("w-10 shrink-0 text-right", who === "LLM" ? "text-warn" : "text-faint")}>{who}</span>
                <span className="text-muted">{what}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-faint">Each arrow from the host is another prompt, another wait, more tokens.</p>
        </div>
        <div className="rounded-xl border border-lime/25 bg-lime/[0.04] p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="text-sm font-medium">Code Mode</div>
            <Badge variant="lime">2 LLM calls · 1 program</Badge>
          </div>
          <ol className="space-y-2">
            {[
              ["LLM", "codemode({ code })  ← whole plan"],
              ["exec", "runPython → runShell → return"],
              ["LLM", "write the answer"]
            ].map(([who, what], i) => (
              <li key={i} className="flex items-center gap-3 font-mono text-xs">
                <span className={cn("w-10 shrink-0 text-right", who === "LLM" ? "text-lime" : "text-faint")}>{who}</span>
                <span className="text-muted">{what}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-faint">
            The gap grows with the task: ten tool calls in a loop are still one program. The model gets one typed API and real control flow.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ---------- Interactive demo ---------- */

function Demo({ onTry }: { onTry: (p: string) => void }) {
  const [failover, setFailover] = useState(false);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const steps = useMemo(() => STEPS.filter((s) => (failover ? !s.normalOnly : !s.failoverOnly)), [failover]);
  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;

  const visited = useMemo(() => {
    const v = new Set<NodeId>();
    steps.slice(0, index).forEach((s) => s.active.forEach((n) => v.add(n)));
    return v;
  }, [steps, index]);

  useEffect(() => {
    if (!playing) return;
    if (last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIndex((i) => i + 1), 4200);
    return () => clearTimeout(t);
  }, [playing, index, last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.target instanceof HTMLElement) || ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, steps.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length]);

  const toggleFailover = () => {
    setFailover((f) => !f);
    setIndex(0);
    setPlaying(false);
  };

  return (
    <section id="demo" className="scroll-mt-6 py-14">
      <SectionHead kicker="02 · live walkthrough" title="Follow one request through the system">
        A replay of a real run. Step through it, or press play. Turn on the failover scenario to see what happens when Groq is rate limited mid-task.
      </SectionHead>

      <div className="rounded-2xl border border-line bg-obsidian-950/80 p-3 sm:p-4">
        {/* prompt + controls */}
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-line bg-surface/60 p-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">prompt</div>
            <div className="text-sm leading-relaxed">{DEMO_PROMPT}</div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              role="switch"
              aria-checked={failover}
              onClick={toggleFailover}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors cursor-pointer",
                failover ? "border-warn/40 bg-warn/10 text-warn" : "border-line text-muted hover:border-line-strong hover:text-paper"
              )}
            >
              <span className={cn("relative h-4 w-7 rounded-full transition-colors", failover ? "bg-warn" : "bg-surface-3")}>
                <span className={cn("absolute top-0.5 size-3 rounded-full bg-obsidian transition-all", failover ? "left-3.5" : "left-0.5")} />
              </span>
              <span className="hidden sm:inline">Groq rate limited</span>
              <span className="sm:hidden">Failover</span>
            </button>
            <Button variant="outline" size="icon-sm" onClick={() => setIndex((i) => Math.max(i - 1, 0))} disabled={index === 0} aria-label="Previous step">
              <ChevronLeft />
            </Button>
            <Button
              size="sm"
              onClick={() => {
                if (last) setIndex(0);
                setPlaying((p) => !p || last);
              }}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause /> : last ? <RotateCcw /> : <Play />}
              {playing ? "Pause" : last ? "Replay" : "Play"}
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => setIndex((i) => Math.min(i + 1, steps.length - 1))} disabled={last} aria-label="Next step">
              <ChevronRight />
            </Button>
          </div>
        </div>

        {/* progress */}
        <div className="mb-4 flex gap-1">
          {steps.map((s, i) => (
            <button
              key={s.id}
              onClick={() => {
                setIndex(i);
                setPlaying(false);
              }}
              title={s.title}
              aria-label={`Step ${i + 1}: ${s.title}`}
              className="group h-5 flex-1 cursor-pointer py-2"
            >
              <span
                className={cn(
                  "block h-1 rounded-full transition-colors",
                  i < index ? "bg-lime-dim" : i === index ? (s.tone === "warn" ? "bg-warn" : "bg-lime") : "bg-surface-3 group-hover:bg-line-strong"
                )}
              />
            </button>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Diagram active={step.active} visited={visited} warn={step.tone === "warn"} failover={failover && steps.indexOf(step) >= steps.findIndex((s) => s.id === "route-fail")} />

          <div className="flex min-w-0 flex-col gap-3">
            <div key={step.id} className="animate-[fadein_.35s_ease] rounded-xl border border-line bg-surface/60 p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[11px] text-faint">
                  {String(index + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
                </span>
                {step.event && <Badge variant={step.tone === "warn" ? "warn" : "lime"}>{step.event}</Badge>}
              </div>
              <h3 className={cn("text-lg font-semibold tracking-tight", step.tone === "warn" && "text-warn")}>{step.title}</h3>
              <p className="hiw-body mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
            </div>
            <CodePanel key={`${step.id}-panel`} panel={step.panel} />
          </div>
        </div>

        {last && (
          <div className="mt-4 flex flex-col items-start justify-between gap-3 rounded-xl border border-lime/25 bg-lime/[0.05] p-4 sm:flex-row sm:items-center">
            <div className="text-sm">
              That was the whole run: <span className="text-lime">{failover ? "3" : "2"} LLM calls</span>, 1 program, 2 sandbox executions
              {failover && ", 1 failover"}.
            </div>
            <Button size="sm" onClick={() => onTry(DEMO_PROMPT)}>
              Run it for real <ArrowRight />
            </Button>
          </div>
        )}
      </div>
      <p className="mt-3 text-center font-mono text-[11px] text-faint">← / → to step · click the progress bar to jump</p>
    </section>
  );
}

function Diagram({ active, visited, warn, failover }: { active: NodeId[]; visited: Set<NodeId>; warn: boolean; failover: boolean }) {
  const node = (id: NodeId) => {
    const n = NODES[id];
    const on = active.includes(id);
    const seen = visited.has(id);
    return (
      <div
        className={cn(
          "relative rounded-xl border p-3 transition-all duration-300",
          on
            ? warn && (id === "llm" || id === "router")
              ? "border-warn/60 bg-warn/[0.08] shadow-[0_0_24px_-6px] shadow-warn/50"
              : "border-lime/60 bg-lime/[0.07] shadow-[0_0_24px_-6px] shadow-lime/50"
            : seen
              ? "border-line-strong bg-surface/70"
              : "border-line bg-surface/30 opacity-60"
        )}
      >
        <div className="flex items-center gap-2">
          <n.icon className={cn("size-4 shrink-0", on ? (warn && (id === "llm" || id === "router") ? "text-warn" : "text-lime") : "text-faint")} />
          <div className="min-w-0 text-[13px] font-medium leading-tight">{n.label}</div>
          {on && <span className="ml-auto size-1.5 shrink-0 animate-pulse-dot rounded-full bg-current text-lime" />}
        </div>
        <div className="mt-1 pl-6 text-[11px] leading-snug text-faint">{id === "llm" ? <LlmChain failover={failover} warn={warn && on} /> : n.sub}</div>
        <div className="mt-1.5 break-all pl-6 font-mono text-[10px] text-faint/80">{n.file}</div>
      </div>
    );
  };

  const lane = (title: string, ids: NodeId[]) => (
    <div>
      <div className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-faint">{title}</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">{ids.map((id) => <div key={id}>{node(id)}</div>)}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface/30 p-3">
      {lane("thinking · the model side", ["agent", "router", "llm"])}
      <Arrow label="one codemode({ code }) call" />
      {lane("doing · the execution side", ["codemode", "executor", "tools"])}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="sm:order-1">{node("ui")}</div>
        <div className="sm:order-2">{node("store")}</div>
        <div className="sm:order-3">{node("docker")}</div>
      </div>
      <div className="px-1 font-mono text-[10px] leading-relaxed text-faint">
        workspace ⇄ SSE ⇄ store · tool host → sandbox (python / node / bash)
      </div>
    </div>
  );
}

function LlmChain({ failover, warn }: { failover: boolean; warn: boolean }) {
  return (
    <span>
      <span className={cn(failover ? "text-faint line-through" : "text-paper/80", warn && "text-warn")}>Groq</span>
      <span> → </span>
      <span className={cn(failover && !warn ? "text-lime" : undefined)}>Gemini</span>
      <span> → Ollama</span>
    </span>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <div className="h-px flex-1 bg-line" />
      <span className="font-mono text-[10px] text-lime-dim">↓ {label}</span>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

function CodePanel({ panel }: { panel: Panel }) {
  return (
    <div className="flex min-h-[260px] min-w-0 flex-1 animate-[fadein_.35s_ease] flex-col overflow-hidden rounded-xl border border-line bg-obsidian-950">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="flex gap-1">
          <span className="size-2 rounded-full bg-surface-3" />
          <span className="size-2 rounded-full bg-surface-3" />
          <span className="size-2 rounded-full bg-surface-3" />
        </span>
        <span className="truncate font-mono text-[11px] text-muted">{panel.label}</span>
        <span className="ml-auto font-mono text-[10px] uppercase text-faint">{panel.lang}</span>
      </div>
      <pre className="max-h-[440px] min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-[1.6] text-paper/90">
        <code>{panel.lang === "js" ? <HighlightJs code={panel.content} /> : panel.content}</code>
      </pre>
    </div>
  );
}

/** Tiny highlighter for the demo snippets: keywords, strings, comments and tool namespaces. */
function HighlightJs({ code }: { code: string }) {
  const parts: ReactNode[] = [];
  const re = /(\/\/[^\n]*|\/\*\*[\s\S]*?\*\/)|(`[\s\S]*?`|"[^"\n]*"|'[^'\n]*')|\b(async|await|const|return|declare|Promise)\b|\b(sandbox|fs|web|codemode)\b(?=[.:])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) parts.push(code.slice(last, m.index));
    const cls = m[1] ? "text-faint" : m[2] ? "text-info" : m[3] ? "text-warn" : "text-lime";
    parts.push(
      <span key={k++} className={cls}>
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  parts.push(code.slice(last));
  return <>{parts}</>;
}

/* ---------- Layers ---------- */

function Layers() {
  const layers = [
    {
      icon: Monitor,
      title: "Web workspace",
      path: "apps/web",
      text: "React + Vite. Chat with execution cards, an inspector (timeline, code, terminal, artifacts, history) and live provider status. Talks to the agent over REST + SSE."
    },
    {
      icon: Workflow,
      title: "Agent runner",
      path: "workers/agent/src/agent",
      text: "The loop: build the request, ask the router, execute codemode calls, append results, repeat until the model answers (max 8 tool steps)."
    },
    {
      icon: Route,
      title: "Provider layer",
      path: "workers/agent/src/providers",
      text: "One interface over Groq, Gemini and Ollama. Errors are classified, retried with backoff or failed over; health and circuit breakers per provider."
    },
    {
      icon: Boxes,
      title: "Code Mode",
      path: "workers/agent/src/codemode",
      text: "Generates TypeScript types from tool schemas, defines the single codemode tool and runs programs through @cloudflare/codemode's runCode."
    },
    {
      icon: Cpu,
      title: "Executors",
      path: "sandbox/codemode-runtime.mjs",
      text: "One runtime, two hosts: a worker-thread V8 context (dev default) or a Docker container. Tool calls are JSON messages back to the host."
    },
    {
      icon: Container,
      title: "Tools + sandbox",
      path: "workers/agent/src/tools · sandbox",
      text: "fs (path-contained workspace), sandbox (Python / Node / bash in Docker, allowlisted installs), web.fetch (public hosts only), searchTools."
    }
  ];
  return (
    <section className="py-14">
      <SectionHead kicker="03 · the parts" title="Six layers, each with one job">
        Every layer can be swapped on its own. Moving to Cloudflare Workers, for example, means replacing the executor factory, not the agent.
      </SectionHead>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {layers.map((l, i) => (
          <div key={l.title} className="rounded-xl border border-line bg-surface/60 p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-lg bg-surface-3">
                <l.icon className="size-3.5 text-lime" />
              </span>
              <span className="font-mono text-[10px] text-faint">0{i + 1}</span>
            </div>
            <div className="text-sm font-medium">{l.title}</div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-lime-dim">{l.path}</div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{l.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- Guarantees ---------- */

function Guarantees() {
  const rows = [
    ["Programs never run twice", "Executions are keyed by (run, tool call id) and by code hash. A program re-emitted after a failover reuses the stored result."],
    ["No silent fallback on config errors", "An invalid key, unknown model or bad request stops the run with a clear error instead of hiding it behind another provider."],
    ["Same agent on every provider", "Identical system prompt, history and tool definition. Gemini thought signatures are kept; foreign tool calls are replayed as transcripts."],
    ["Untrusted code stays boxed", "The program sees only typed stubs. Sandbox containers have no network, a read-only root, no capabilities and resource limits."],
    ["The web tool can't reach your network", "Private, loopback, link-local and metadata addresses are blocked, including after redirects."],
    ["Nothing is lost on reload", "Every event is persisted in SQLite and replayed over SSE with Last-Event-ID."]
  ];
  return (
    <section className="py-14">
      <SectionHead kicker="04 · guarantees" title="What you can rely on" />
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        {rows.map(([t, d]) => (
          <div key={t} className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-lime" />
            <div>
              <div className="text-sm font-medium">{t}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{d}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Closing({ onTry }: { onTry: (p: string) => void }) {
  return (
    <section className="mt-6 rounded-2xl border border-line bg-surface/60 p-6 sm:p-8">
      <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">Your turn.</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Open the workspace with the demo prompt filled in, run it, then click the execution card to see the real program, logs and files in the inspector.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={() => onTry(DEMO_PROMPT)}>
          Open the workspace <ArrowRight />
        </Button>
        <a href="#" className="inline-flex h-9 items-center rounded-lg border border-line px-4 text-sm text-paper hover:border-line-strong hover:bg-surface-2">
          Start from scratch
        </a>
      </div>
    </section>
  );
}
