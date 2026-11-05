/**
 * Code Mode executors for Node.js.
 *
 * Both classes implement the `Executor` contract from @cloudflare/codemode
 * (`execute(code, providers) → { result, error?, logs? }`), the same interface that
 * Cloudflare's managed `DynamicWorkerExecutor` implements. AgentOS cannot use
 * DynamicWorkerExecutor locally: it needs a Workers `WorkerLoader` binding (Dynamic
 * Workers), which only exists inside the Cloudflare runtime and may need a paid plan.
 *
 *  - LocalWorkerExecutor: development adapter. Runs the program in a fresh V8 context
 *    inside a worker thread with an empty environment, a heap limit and a hard
 *    wall-clock timeout (the thread is terminated). Fast (~30 ms), but node:vm is not a
 *    security boundary, so use it for local development only.
 *  - DockerExecutor: runs the same runtime inside a throwaway container with no network,
 *    a read-only root filesystem, dropped capabilities and memory / CPU / PID limits.
 *
 * Tool calls from the sandbox are dispatched back to the host functions in the
 * resolved providers; only JSON strings cross the boundary.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import type { ExecuteResult, Executor, ResolvedProvider } from "@cloudflare/codemode";

export interface ExecutorHooks {
  onLog?: (level: string, line: string) => void;
}

export interface ExecutorInfo {
  id: "local-worker" | "docker";
  label: string;
  managed: false;
  isolation: string;
  note: string;
}

type ToolFns = Record<string, (...args: unknown[]) => Promise<unknown>>;

type RuntimeMessage =
  | { type: "log"; level: string; line: string }
  | { type: "tool-call"; id: string; namespace: string; name: string; args: string }
  | { type: "done"; ok: true; result: string }
  | { type: "done"; ok: false; error: string };

function toProviders(providersOrFns: ResolvedProvider[] | ToolFns): ResolvedProvider[] {
  return Array.isArray(providersOrFns) ? providersOrFns : [{ name: "codemode", fns: providersOrFns }];
}

/** Default hard cap on an execution's total wall-clock time, including time spent in host tools. */
export const DEFAULT_MAX_WALL_MS = 5 * 60_000;

/** Shared message handling for both transports. */
class RuntimeSession {
  readonly logs: string[] = [];
  private readonly fnIndex = new Map<string, Map<string, (...args: unknown[]) => Promise<unknown>>>();
  private inFlight = 0;
  private busySince = 0;
  private toolMs = 0;

  constructor(
    providers: ResolvedProvider[],
    private readonly send: (msg: unknown) => void,
    private readonly hooks: ExecutorHooks,
    private readonly maxLogLines = 500
  ) {
    for (const p of providers) this.fnIndex.set(p.name, new Map(Object.entries(p.fns)));
  }

  /** Wall time during which at least one host tool call was in flight. */
  toolTimeMs(now = Date.now()): number {
    return this.toolMs + (this.inFlight > 0 ? now - this.busySince : 0);
  }

  namespaces() {
    return [...this.fnIndex.entries()].map(([name, fns]) => ({ name, fns: [...fns.keys()] }));
  }

  /** Returns a final ExecuteResult when the program finished, otherwise undefined. */
  handle(msg: RuntimeMessage): ExecuteResult | undefined {
    if (msg.type === "log") {
      const line = msg.level === "log" || msg.level === "info" ? msg.line : `[${msg.level}] ${msg.line}`;
      if (this.logs.length < this.maxLogLines) this.logs.push(line);
      else if (this.logs.length === this.maxLogLines) this.logs.push("[logs truncated]");
      this.hooks.onLog?.(msg.level, msg.line);
      return undefined;
    }
    if (msg.type === "tool-call") {
      void this.dispatch(msg);
      return undefined;
    }
    if (msg.type === "done") {
      if (msg.ok) {
        let result: unknown;
        try {
          result = JSON.parse(msg.result);
        } catch {
          result = msg.result;
        }
        return { result, logs: this.logs };
      }
      return { result: undefined, error: msg.error, logs: this.logs };
    }
    return undefined;
  }

  private async dispatch(msg: Extract<RuntimeMessage, { type: "tool-call" }>) {
    if (this.inFlight++ === 0) this.busySince = Date.now();
    try {
      await this.dispatchCall(msg);
    } finally {
      if (--this.inFlight === 0) this.toolMs += Date.now() - this.busySince;
    }
  }

  private async dispatchCall(msg: Extract<RuntimeMessage, { type: "tool-call" }>) {
    const fn = this.fnIndex.get(msg.namespace)?.get(msg.name);
    if (!fn) {
      const available = [...(this.fnIndex.get(msg.namespace)?.keys() ?? [])].join(", ");
      this.send({
        type: "tool-result",
        id: msg.id,
        ok: false,
        error: this.fnIndex.has(msg.namespace)
          ? `Tool "${msg.namespace}.${msg.name}" does not exist. Available: ${available}`
          : `Namespace "${msg.namespace}" does not exist`
      });
      return;
    }
    try {
      const args = msg.args ? JSON.parse(msg.args) : {};
      const value = await fn(args);
      this.send({ type: "tool-result", id: msg.id, ok: true, result: JSON.stringify(value === undefined ? null : value) });
    } catch (err) {
      this.send({ type: "tool-result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Arms an execution's timeout and returns a function that disarms it.
 *
 * `timeoutMs` limits the program's own run time: wall time minus time spent waiting on host
 * tools. Host tools have their own limits (a package install may take minutes), so a fast
 * program that waits on a slow tool is not killed. `maxWallMs` is a hard cap on total wall
 * time, so a program cannot stay alive indefinitely by keeping tool calls pending.
 */
function armDeadline(
  session: RuntimeSession,
  opts: { timeoutMs: number; graceMs?: number; maxWallMs: number },
  onTimeout: (error: string) => void
): () => void {
  const started = Date.now();
  const budget = opts.timeoutMs + (opts.graceMs ?? 0);
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    const now = Date.now();
    const wall = now - started;
    const program = wall - session.toolTimeMs(now);
    if (wall >= opts.maxWallMs) return onTimeout(`Execution exceeded the wall-clock limit of ${opts.maxWallMs}ms (time spent in tools included)`);
    if (program >= budget) return onTimeout(`Execution timed out after ${opts.timeoutMs}ms`);
    timer = setTimeout(check, Math.max(10, Math.min(budget - program, opts.maxWallMs - wall)));
  };
  timer = setTimeout(check, Math.min(budget, opts.maxWallMs));
  return () => clearTimeout(timer);
}

export interface LocalWorkerExecutorOptions extends ExecutorHooks {
  runtimePath: string;
  /** Limit on the program's own run time; time waiting on host tools is not counted. */
  timeoutMs?: number;
  /** Hard cap on total wall time, tools included. Default 5 minutes. */
  maxWallMs?: number;
  memoryMb?: number;
}

export class LocalWorkerExecutor implements Executor {
  static readonly info: ExecutorInfo = {
    id: "local-worker",
    label: "Local worker-isolate executor",
    managed: false,
    isolation: "Fresh V8 context in a worker thread: empty env, no require/process/fetch, eval disabled, heap limit, hard timeout",
    note: "Development adapter that implements the @cloudflare/codemode Executor interface. It is NOT Cloudflare's managed DynamicWorkerExecutor and node:vm is not a security boundary; use CODEMODE_EXECUTOR=docker for stronger isolation."
  };

  constructor(private readonly opts: LocalWorkerExecutorOptions) {}

  execute(code: string, providersOrFns: ResolvedProvider[] | ToolFns): Promise<ExecuteResult> {
    const providers = toProviders(providersOrFns);
    const timeoutMs = this.opts.timeoutMs ?? 30_000;

    return new Promise<ExecuteResult>((resolve) => {
      let settled = false;
      let worker: Worker | undefined;
      const session = new RuntimeSession(providers, (m) => worker?.postMessage(m), this.opts);
      const finish = (r: ExecuteResult) => {
        if (settled) return;
        settled = true;
        disarm();
        void worker?.terminate();
        resolve(r);
      };
      const disarm = armDeadline(session, { timeoutMs, maxWallMs: this.opts.maxWallMs ?? DEFAULT_MAX_WALL_MS }, (error) =>
        finish({ result: undefined, error, logs: session.logs })
      );
      try {
        worker = new Worker(this.opts.runtimePath, {
          workerData: { code, namespaces: session.namespaces(), syncTimeoutMs: timeoutMs },
          env: {},
          argv: [],
          execArgv: [],
          stdout: true,
          stderr: true,
          resourceLimits: {
            maxOldGenerationSizeMb: this.opts.memoryMb ?? 128,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4
          }
        });
      } catch (err) {
        finish({ result: undefined, error: `Failed to start executor: ${(err as Error).message}`, logs: [] });
        return;
      }
      worker.on("message", (msg: RuntimeMessage) => {
        const r = session.handle(msg);
        if (r) finish(r);
      });
      worker.on("error", (err) => {
        const oom = /heap|memory/i.test(err.message) || (err as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY";
        finish({
          result: undefined,
          error: oom ? `Execution exceeded the ${this.opts.memoryMb ?? 128}MB memory limit` : err.message,
          logs: session.logs
        });
      });
      worker.on("exit", (code) => {
        if (!settled) finish({ result: undefined, error: `Executor exited unexpectedly (code ${code})`, logs: session.logs });
      });
    });
  }
}

export interface DockerExecutorOptions extends ExecutorHooks {
  image: string;
  /** Limit on the program's own run time; time waiting on host tools is not counted. */
  timeoutMs?: number;
  /** Hard cap on total wall time, tools included. Default 5 minutes. */
  maxWallMs?: number;
  memoryMb?: number;
  cpus?: string;
  pidsLimit?: number;
  dockerBin?: string;
}

export class DockerExecutor implements Executor {
  static readonly info: ExecutorInfo = {
    id: "docker",
    label: "Docker container executor",
    managed: false,
    isolation: "Throwaway container: --network none, read-only root fs, all capabilities dropped, no-new-privileges, memory/CPU/PID limits, hard timeout",
    note: "Runs the same Code Mode runtime as the local executor inside Docker. Slower to start (~0.5–1 s) but isolated from the host. Not Cloudflare's managed DynamicWorkerExecutor."
  };

  constructor(private readonly opts: DockerExecutorOptions) {}

  execute(code: string, providersOrFns: ResolvedProvider[] | ToolFns): Promise<ExecuteResult> {
    const providers = toProviders(providersOrFns);
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const memoryMb = this.opts.memoryMb ?? 128;
    const name = `agentos-cm-${randomUUID().slice(0, 12)}`;
    const docker = this.opts.dockerBin ?? "docker";
    const args = [
      "run", "--rm", "-i", "--name", name,
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--memory", `${memoryMb + 64}m`, "--memory-swap", `${memoryMb + 64}m`,
      "--cpus", this.opts.cpus ?? "0.5",
      "--pids-limit", String(this.opts.pidsLimit ?? 64),
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "10001:10001",
      this.opts.image,
      "node", `--max-old-space-size=${memoryMb}`, "/runtime/codemode-runtime.mjs"
    ];

    return new Promise<ExecuteResult>((resolve) => {
      let settled = false;
      const child = spawn(docker, args, { stdio: ["pipe", "pipe", "pipe"] });
      const send = (m: unknown) => {
        if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(m) + "\n");
      };
      const session = new RuntimeSession(providers, send, this.opts);
      let stderr = "";
      const finish = (r: ExecuteResult) => {
        if (settled) return;
        settled = true;
        disarm();
        child.stdin.end();
        spawn(docker, ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {});
        resolve(r);
      };
      const disarm = armDeadline(
        session,
        { timeoutMs, graceMs: 5_000 /* container start-up */, maxWallMs: this.opts.maxWallMs ?? DEFAULT_MAX_WALL_MS },
        (error) => finish({ result: undefined, error, logs: session.logs })
      );
      child.on("error", (err) =>
        finish({ result: undefined, error: `Docker is not available: ${err.message}`, logs: session.logs })
      );
      child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
      createInterface({ input: child.stdout }).on("line", (line) => {
        let msg: RuntimeMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        const r = session.handle(msg);
        if (r) finish(r);
      });
      child.on("close", (code) => {
        if (!settled) {
          const oom = code === 137;
          finish({
            result: undefined,
            error: oom
              ? `Execution was killed (memory limit ${memoryMb}MB or timeout)`
              : `Executor container exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
            logs: session.logs
          });
        }
      });
      send({ type: "start", code, namespaces: session.namespaces(), syncTimeoutMs: timeoutMs });
    });
  }
}
