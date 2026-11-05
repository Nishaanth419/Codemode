import {
  AlertTriangle,
  ArrowRightLeft,
  ArrowUp,
  Check,
  ChevronDown,
  CircleSlash,
  Code2,
  Info,
  Loader2,
  Square,
  Terminal as TerminalIcon,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatItem } from "@/lib/timeline";
import type { ProviderName } from "@/lib/types";
import { cn, formatDuration } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const PROVIDER_LABEL: Record<string, string> = { groq: "Groq", gemini: "Gemini", ollama: "Ollama" };

export function ModelTag({ provider, model }: { provider?: ProviderName; model?: string }) {
  if (!provider) return null;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-faint">
      <span className={cn("size-1.5 rounded-full", provider === "groq" ? "bg-lime" : provider === "gemini" ? "bg-info" : "bg-warn")} />
      <span className="text-muted">{PROVIDER_LABEL[provider] ?? provider}</span>
      {model && <span>{model}</span>}
    </span>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-surface-3 px-4 py-2.5 text-[14px] leading-relaxed text-paper ring-1 ring-inset ring-line-strong">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  return (
    <div className="group">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="grid size-5 place-items-center rounded-md bg-lime/10 ring-1 ring-inset ring-lime/30">
          <span className="size-1.5 rounded-full bg-lime" />
        </div>
        <ModelTag provider={item.provider} model={item.model} />
        {item.streaming && <Loader2 className="size-3 animate-spin text-faint" />}
        {!item.streaming && item.latencyMs !== undefined && (
          <span className="font-mono text-[10px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
            {formatDuration(item.latencyMs)}
            {item.usage?.totalTokens ? ` · ${item.usage.totalTokens} tok` : ""}
          </span>
        )}
      </div>
      <div className="prose-agent pl-7 text-paper/95">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
      </div>
    </div>
  );
}

function ExecutionCard({ item, selected, onInspect }: { item: Extract<ChatItem, { kind: "execution" }>; selected: boolean; onInspect: () => void }) {
  const [open, setOpen] = useState(false);
  const running = item.status === "running";
  const failed = item.status === "failed";
  const lines = item.code.split("\n");
  const preview = open ? item.code : lines.slice(0, 6).join("\n");
  const outputTail = item.output
    .map((o) => o.text)
    .join("")
    .split("\n")
    .filter(Boolean)
    .slice(-4);

  return (
    <div
      className={cn(
        "ml-7 overflow-hidden rounded-xl border bg-surface/70 transition-colors",
        selected ? "border-lime/40" : "border-line hover:border-line-strong",
        running && "shadow-[0_0_0_1px] shadow-lime/10"
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div
          className={cn(
            "grid size-5 place-items-center rounded-md",
            running ? "bg-lime/15 text-lime" : failed ? "bg-danger/15 text-danger" : "bg-lime/15 text-lime"
          )}
        >
          {running ? <Loader2 className="size-3 animate-spin" /> : failed ? <X className="size-3" /> : <Check className="size-3" />}
        </div>
        <span className="text-xs font-medium">Code Mode program</span>
        <Badge variant={running ? "lime" : failed ? "danger" : "outline"}>{running ? "executing" : item.status}</Badge>
        {item.durationMs !== undefined && <span className="font-mono text-[11px] text-faint">{formatDuration(item.durationMs)}</span>}
        <div className="ml-auto flex items-center gap-2">
          <ModelTag provider={item.provider} model={item.model} />
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onInspect}>
            <Code2 className="!size-3" /> Inspect
          </Button>
        </div>
      </div>

      <button onClick={() => setOpen(!open)} className="relative block w-full text-left cursor-pointer">
        <pre className="overflow-x-auto bg-obsidian-950/70 px-4 py-3 font-mono text-[12px] leading-relaxed text-paper/85">{preview}</pre>
        {lines.length > 6 && (
          <div className="absolute bottom-1.5 right-3 flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-faint">
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            {open ? "less" : `${lines.length - 6} more lines`}
          </div>
        )}
      </button>

      {item.toolCalls.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
          {item.toolCalls.map((t) => (
            <span
              key={t.callId}
              title={t.error ?? JSON.stringify(t.args)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset",
                t.ok === undefined ? "text-lime ring-lime/30" : t.ok ? "text-muted ring-line" : "text-danger ring-danger/30"
              )}
            >
              {t.ok === undefined ? <Loader2 className="size-3 animate-spin" /> : t.ok ? <Check className="size-3 text-lime" /> : <X className="size-3" />}
              {t.name}
              {t.durationMs !== undefined && <span className="text-faint">{formatDuration(t.durationMs)}</span>}
            </span>
          ))}
        </div>
      )}

      {(outputTail.length > 0 || item.error || (item.status === "completed" && item.result !== undefined)) && (
        <div className="space-y-1.5 border-t border-line bg-obsidian-950/40 px-3 py-2 font-mono text-[11px]">
          {outputTail.length > 0 && (
            <div className="text-faint">
              <TerminalIcon className="mr-1 inline size-3" />
              {outputTail.map((l, i) => (
                <div key={i} className="truncate pl-4 text-muted">
                  {l}
                </div>
              ))}
            </div>
          )}
          {item.error && <div className="whitespace-pre-wrap text-danger">✕ {item.error}</div>}
          {item.status === "completed" && item.result !== undefined && (
            <div className="truncate text-lime/90">
              → <span className="text-paper/80">{JSON.stringify(item.result)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Notice({ item }: { item: Extract<ChatItem, { kind: "notice" }> }) {
  const styles = {
    switch: { icon: ArrowRightLeft, cls: "border-warn/30 bg-warn/[0.06] text-warn" },
    warn: { icon: AlertTriangle, cls: "border-warn/25 bg-warn/[0.05] text-warn" },
    error: { icon: CircleSlash, cls: "border-danger/30 bg-danger/[0.06] text-danger" },
    info: { icon: Info, cls: "border-line bg-surface/50 text-muted" }
  }[item.level];
  const Icon = styles.icon;
  return (
    <div className={cn("ml-7 flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs", styles.cls)}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-medium">{item.text}</div>
        {item.detail && <div className="mt-0.5 text-faint">{item.detail}</div>}
      </div>
    </div>
  );
}

export function ChatTimeline(props: { items: ChatItem[]; running: boolean; selectedExecution: string | null; onInspect: (id: string) => void }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [props.items]);
  const last = props.items[props.items.length - 1];
  const thinking = props.running && (!last || last.kind === "user" || (last.kind === "execution" && last.status !== "running") || last.kind === "notice");

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-8">
      {props.items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserBubble key={item.id} text={item.text} />;
          case "assistant":
            return <AssistantMessage key={item.id} item={item} />;
          case "execution":
            return <ExecutionCard key={item.id} item={item} selected={props.selectedExecution === item.id} onInspect={() => props.onInspect(item.id)} />;
          case "notice":
            return <Notice key={item.id} item={item} />;
        }
      })}
      {thinking && (
        <div className="flex items-center gap-2 pl-7 font-mono text-xs text-faint">
          <span className="flex gap-1">
            <span className="size-1 animate-bounce rounded-full bg-lime [animation-delay:-0.3s]" />
            <span className="size-1 animate-bounce rounded-full bg-lime [animation-delay:-0.15s]" />
            <span className="size-1 animate-bounce rounded-full bg-lime" />
          </span>
          thinking
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

export function Composer(props: {
  disabled?: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hint?: React.ReactNode;
  draft: string;
  setDraft: (s: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [props.draft]);
  const send = () => {
    const t = props.draft.trim();
    if (!t || props.running || props.disabled) return;
    props.onSend(t);
    props.setDraft("");
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-5">
      <div className="rounded-2xl border border-line-strong bg-surface/90 shadow-2xl shadow-black/40 backdrop-blur focus-within:border-lime/40">
        <textarea
          ref={ref}
          value={props.draft}
          onChange={(e) => props.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          placeholder="Describe a task — AgentOS writes and runs the code…"
          className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-relaxed text-paper outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
          <div className="text-[11px] text-faint">{props.hint}</div>
          {props.running ? (
            <Button size="sm" variant="danger" onClick={props.onStop}>
              <Square className="!size-3 fill-current" /> Stop
            </Button>
          ) : (
            <Button size="icon-sm" onClick={send} disabled={!props.draft.trim() || props.disabled} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
