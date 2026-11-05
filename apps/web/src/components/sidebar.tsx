import { Boxes, ChevronRight, MessageSquareText, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Session, SystemStatus, ToolNamespace } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { RuntimeSummary } from "./provider-status";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 place-items-center rounded-lg bg-lime text-obsidian">
        <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
          <path d="M8 23 L16 7 L24 23" stroke="currentColor" strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16" cy="19.5" r="2.3" fill="currentColor" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight">AgentOS</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">code mode workspace</div>
      </div>
    </div>
  );
}

export function Sidebar(props: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  tools: ToolNamespace[];
  status: SystemStatus | null;
  onInsertTool: (name: string) => void;
}) {
  const [openNs, setOpenNs] = useState<string | null>("sandbox");
  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col border-r border-line bg-obsidian-950 lg:bg-obsidian-950/60">
      <div className="flex h-14 items-center justify-between px-4">
        <Logo />
      </div>
      <div className="px-3 pb-3">
        <Button className="w-full justify-start" onClick={props.onNew}>
          <Plus /> New session
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3">
          <SectionLabel>Sessions</SectionLabel>
          <div className="space-y-0.5">
            {props.sessions.length === 0 && <p className="px-2 py-3 text-xs text-faint">No sessions yet.</p>}
            {props.sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => props.onSelect(s.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors",
                  s.id === props.activeId ? "bg-surface-2 text-paper ring-1 ring-inset ring-line" : "text-muted hover:bg-surface hover:text-paper"
                )}
              >
                <MessageSquareText className={cn("size-3.5 shrink-0", s.id === props.activeId ? "text-lime" : "text-faint")} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{s.title}</div>
                  <div className="font-mono text-[10px] text-faint">{timeAgo(s.updated_at)}</div>
                </div>
                <button
                  className="invisible rounded p-1 text-faint hover:bg-surface-3 hover:text-danger group-hover:visible cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDelete(s.id);
                  }}
                  aria-label="Delete session"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>

          <SectionLabel className="mt-6">
            <span className="flex items-center gap-1.5">
              <Boxes className="size-3" /> Tools in the sandbox
            </span>
          </SectionLabel>
          <div className="space-y-0.5 pb-4">
            {props.tools.map((ns) => (
              <div key={ns.name}>
                <button
                  onClick={() => setOpenNs(openNs === ns.name ? null : ns.name)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-xs text-muted hover:bg-surface hover:text-paper cursor-pointer"
                >
                  <ChevronRight className={cn("size-3 transition-transform", openNs === ns.name && "rotate-90")} />
                  <span className="text-lime/90">{ns.name}</span>
                  <span className="ml-auto text-faint">{ns.tools.length}</span>
                </button>
                {openNs === ns.name && (
                  <div className="mb-1 ml-[18px] border-l border-line pl-2">
                    {ns.tools.map((t) => (
                      <button
                        key={t.name}
                        title={t.description}
                        onClick={() => props.onInsertTool(`${ns.name}.${t.name}`)}
                        className="block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] text-faint hover:bg-surface hover:text-paper cursor-pointer"
                      >
                        .{t.name}()
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>

      <div className="border-t border-line p-3">
        <RuntimeSummary status={props.status} />
      </div>
    </aside>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mb-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-faint", className)}>{children}</div>;
}
