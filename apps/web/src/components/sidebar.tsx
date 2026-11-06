import { Boxes, ChevronRight, MessageSquareText, Plug, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { McpServerStatus, Session, SystemStatus, ToolNamespace } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { RuntimeSummary } from "./provider-status";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
          <div className="space-y-0.5">
            {props.tools
              .filter((ns) => ns.source !== "mcp")
              .map((ns) => (
                <NamespaceRow key={ns.name} ns={ns} open={openNs === ns.name} onToggle={() => setOpenNs(openNs === ns.name ? null : ns.name)} onInsertTool={props.onInsertTool} />
              ))}
          </div>

          <SectionLabel className="mt-5">
            <span className="flex items-center gap-1.5">
              <Plug className="size-3" /> MCP servers
            </span>
          </SectionLabel>
          <div className="space-y-0.5 pb-4">
            {!props.status?.mcp?.servers.length && (
              <p className="px-2 py-1.5 text-[11px] leading-relaxed text-faint">
                None connected. Add servers to <span className="font-mono">mcp.json</span> and set <span className="font-mono">MCP_CONFIG_FILE</span>.
              </p>
            )}
            {props.status?.mcp?.servers.map((srv) => {
              const ns = props.tools.find((n) => n.source === "mcp" && n.server === srv.name);
              return (
                <NamespaceRow
                  key={srv.name}
                  ns={ns}
                  mcp={srv}
                  open={openNs === srv.namespace}
                  onToggle={() => setOpenNs(openNs === srv.namespace ? null : srv.namespace)}
                  onInsertTool={props.onInsertTool}
                />
              );
            })}
          </div>
        </div>
      </ScrollArea>

      <div className="border-t border-line p-3">
        <RuntimeSummary status={props.status} />
      </div>
    </aside>
  );
}

const MCP_DOT: Record<McpServerStatus["state"], string> = {
  connected: "bg-lime shadow-[0_0_6px] shadow-lime/70",
  connecting: "bg-warn animate-pulse-dot",
  error: "bg-danger",
  disabled: "bg-surface-3"
};

const MCP_LABEL: Record<McpServerStatus["state"], string> = {
  connected: "connected",
  connecting: "connecting…",
  error: "unavailable",
  disabled: "disabled"
};

/** One namespace in the tool catalog. MCP namespaces carry a server-health dot and stay listed while the server is down. */
function NamespaceRow(props: {
  ns?: ToolNamespace;
  mcp?: McpServerStatus;
  open: boolean;
  onToggle: () => void;
  onInsertTool: (name: string) => void;
}) {
  const { ns, mcp } = props;
  const name = ns?.name ?? mcp?.namespace ?? "";
  const tools = ns?.tools ?? [];
  const expandable = tools.length > 0 || Boolean(mcp?.error);
  const row = (
    <button
      onClick={expandable ? props.onToggle : undefined}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-xs text-muted hover:bg-surface hover:text-paper",
        expandable && "cursor-pointer"
      )}
      aria-label={mcp ? `MCP server ${mcp.name}: ${MCP_LABEL[mcp.state]}` : undefined}
    >
      <ChevronRight className={cn("size-3 shrink-0 transition-transform", props.open && "rotate-90", !expandable && "opacity-0")} />
      {mcp && <span className={cn("size-1.5 shrink-0 rounded-full", MCP_DOT[mcp.state])} />}
      <span className={cn("truncate", mcp && mcp.state !== "connected" ? "text-faint" : "text-lime/90")}>{name}</span>
      <span className="ml-auto shrink-0 text-faint">{mcp && mcp.state !== "connected" ? MCP_LABEL[mcp.state] : tools.length}</span>
    </button>
  );
  return (
    <div>
      {mcp ? (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>{row}</TooltipTrigger>
          <TooltipContent side="right" className="w-80">
            <div className="mb-1 font-semibold">
              MCP server “{mcp.name}” <span className="font-normal text-faint">· {mcp.transport}</span>
            </div>
            <div className="break-all font-mono text-[11px] text-muted">{mcp.target}</div>
            {mcp.server && (
              <div className="mt-1 text-faint">
                {mcp.server.name} {mcp.server.version}
              </div>
            )}
            {mcp.description && <p className="mt-1.5 text-muted">{mcp.description}</p>}
            <p className="mt-1.5 text-muted">
              Programs call it as <span className="font-mono text-lime">{mcp.namespace}.*</span>; credentials stay on the server.
            </p>
            {mcp.error && <p className="mt-1.5 text-danger">{mcp.error}</p>}
            {mcp.nextRetryAt && mcp.state === "error" && <p className="mt-1 text-faint">Retrying at {new Date(mcp.nextRetryAt).toLocaleTimeString()}</p>}
          </TooltipContent>
        </Tooltip>
      ) : (
        row
      )}
      {props.open && (
        <div className="mb-1 ml-[18px] border-l border-line pl-2">
          {mcp?.error && mcp.state !== "connected" && <p className="px-2 py-1 text-[11px] leading-snug text-danger/90 [overflow-wrap:anywhere]">{mcp.error}</p>}
          {tools.map((t) => (
            <button
              key={t.name}
              title={t.mcpName && t.mcpName !== t.name ? `MCP tool "${t.mcpName}": ${t.description}` : t.description}
              onClick={() => props.onInsertTool(`${name}.${t.name}`)}
              className="block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] text-faint hover:bg-surface hover:text-paper cursor-pointer"
            >
              .{t.name}()
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mb-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-faint", className)}>{children}</div>;
}
