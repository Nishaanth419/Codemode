import { ArrowRightLeft, Cpu, ShieldCheck } from "lucide-react";
import { useNow } from "@/hooks/use-agent";
import type { ProviderHealth, ProviderStatus, SystemStatus } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const STATUS_LABEL: Record<ProviderStatus, string> = {
  active: "Active",
  standby: "Standby",
  rate_limited: "Rate Limited",
  unavailable: "Unavailable",
  unconfigured: "No key"
};

const STATUS_STYLE: Record<ProviderStatus, { dot: string; text: string; ring: string }> = {
  active: { dot: "bg-lime shadow-[0_0_10px] shadow-lime/70", text: "text-lime", ring: "ring-lime/30" },
  standby: { dot: "bg-info/80", text: "text-info", ring: "ring-line" },
  rate_limited: { dot: "bg-warn animate-pulse-dot", text: "text-warn", ring: "ring-warn/30" },
  unavailable: { dot: "bg-danger", text: "text-danger", ring: "ring-danger/30" },
  unconfigured: { dot: "bg-faint", text: "text-faint", ring: "ring-line" }
};

export function statusLabel(p: ProviderHealth) {
  return STATUS_LABEL[p.status];
}

function countdown(iso: string | null, now: number) {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function ProviderPill({ p, now }: { p: ProviderHealth; now: number }) {
  const style = STATUS_STYLE[p.status];
  const wait = p.rateLimited || p.status === "unavailable" ? countdown(p.retryAfter, now) : null;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "group flex items-center gap-2 rounded-lg bg-surface/80 px-2.5 py-1.5 ring-1 ring-inset transition-colors hover:bg-surface-2 cursor-default",
            style.ring
          )}
          aria-label={`${p.label}: ${STATUS_LABEL[p.status]}`}
        >
          <span className={cn("size-1.5 rounded-full", style.dot)} />
          <span className="hidden text-xs font-medium text-paper sm:inline">{p.label}</span>
          <span className={cn("whitespace-nowrap font-mono text-[11px]", style.text)}>
            {STATUS_LABEL[p.status]}
            {wait && wait !== "now" ? ` · ${wait}` : ""}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", style.dot)} />
            <span className="font-semibold">{p.label}</span>
            <span className="text-faint capitalize">{p.role}</span>
          </div>
          <span className={cn("font-mono text-[11px]", style.text)}>{p.status === "unconfigured" ? "Not configured (no API key)" : STATUS_LABEL[p.status]}</span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 py-2.5 text-[11px]">
          <dt className="text-faint">Model</dt>
          <dd className="truncate font-mono text-paper">{p.model}</dd>
          <dt className="text-faint">Last success</dt>
          <dd>{timeAgo(p.lastSuccessAt)}</dd>
          <dt className="text-faint">Requests</dt>
          <dd className="font-mono">
            {p.requestsMade} <span className="text-faint">({p.successes} ok · {p.failures} failed)</span>
          </dd>
          <dt className="text-faint">Consecutive fails</dt>
          <dd className="font-mono">{p.consecutiveFailures}</dd>
          <dt className="text-faint">Rate limited</dt>
          <dd>{p.rateLimited ? `yes — retry ${p.retryAfter ? `at ${new Date(p.retryAfter).toLocaleTimeString()}` : "later"}` : "no"}</dd>
          <dt className="text-faint">Remaining quota</dt>
          <dd className="text-muted">Not reported by provider</dd>
          {p.lastError && (
            <>
              <dt className="text-faint">Last error</dt>
              <dd className="text-danger/90">
                {p.lastError.summary}
                <div className="text-faint">{timeAgo(p.lastError.at)}</div>
              </dd>
            </>
          )}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

export function ProviderStatusBar({ status }: { status: SystemStatus | null }) {
  const now = useNow(Boolean(status?.llm.providers.some((p) => p.retryAfter)));
  if (!status) return <div className="h-8 w-64 animate-pulse rounded-lg bg-surface" />;
  const current = status.llm.providers.find((p) => p.name === status.llm.currentProvider);
  return (
    <div className="flex items-center gap-2">
      {status.llm.providers.map((p) => (
        <ProviderPill key={p.name} p={p} now={now} />
      ))}
      <div className="ml-1 hidden items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[11px] text-muted 2xl:flex">
        <ArrowRightLeft className="size-3.5 text-faint" />
        {current ? (
          <span>
            Using <span className="font-medium text-paper">{current.label}</span>
          </span>
        ) : (
          <span className="text-danger">No provider available</span>
        )}
        {!status.llm.autoFailover && <span className="text-warn">· failover off</span>}
      </div>
    </div>
  );
}

/** Compact runtime summary for the sidebar footer. */
export function RuntimeSummary({ status }: { status: SystemStatus | null }) {
  if (!status) return null;
  const sbx = status.sandbox;
  return (
    <div className="space-y-2 text-[11px]">
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <div className="flex items-start gap-2 rounded-lg bg-surface px-2.5 py-2 ring-1 ring-inset ring-line cursor-default">
            <Cpu className="mt-0.5 size-3.5 shrink-0 text-lime" />
            <div className="min-w-0">
              <div className="font-medium text-paper">{status.executor.label}</div>
              <div className="text-faint">Code Mode executor · local adapter</div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="w-80">
          <div className="mb-1 font-semibold">{status.executor.label}</div>
          <p className="text-muted">{status.executor.isolation}</p>
          <p className="mt-2 text-warn/90">{status.executor.note}</p>
        </TooltipContent>
      </Tooltip>
      <div className="flex items-start gap-2 rounded-lg bg-surface px-2.5 py-2 ring-1 ring-inset ring-line">
        <ShieldCheck className={cn("mt-0.5 size-3.5 shrink-0", sbx.available && sbx.imagePresent ? "text-lime" : "text-warn")} />
        <div className="min-w-0">
          <div className="font-medium text-paper">Docker sandbox</div>
          <div className="truncate text-faint">
            {!sbx.available ? "Docker unavailable" : sbx.imagePresent ? `${sbx.image} · v${sbx.version}` : `Image missing: run npm run sandbox:build`}
          </div>
        </div>
      </div>
    </div>
  );
}
