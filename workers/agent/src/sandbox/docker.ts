/**
 * Docker sandbox for Python, Node.js and shell execution.
 *
 * Every run is a fresh container from SANDBOX_IMAGE with:
 *   --network none            (except package installs, see packages.ts)
 *   --read-only               root filesystem; only /workspace (session dir) and a small /tmp are writable
 *   --cap-drop ALL, --security-opt no-new-privileges, non-root user
 *   --memory / --cpus / --pids-limit resource limits
 *   a hard wall-clock timeout, after which the container is killed
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SandboxLimits {
  image: string;
  timeoutMs: number;
  memoryMb: number;
  cpus: string;
  pidsLimit: number;
}

export interface SandboxRunOptions {
  mountDir: string;
  argv: string[];
  stdin?: string;
  timeoutMs?: number;
  network?: "none" | "bridge";
  env?: Record<string, string>;
  tmpfsMb?: number;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

const MAX_OUTPUT = 64_000;

export interface DockerStatus {
  available: boolean;
  version?: string;
  imagePresent: boolean;
  image: string;
  error?: string;
}

export class DockerSandbox {
  constructor(
    readonly limits: SandboxLimits,
    private readonly dockerBin = "docker"
  ) {}

  status(): DockerStatus {
    const v = spawnSync(this.dockerBin, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 5000 });
    if (v.status !== 0) {
      return { available: false, imagePresent: false, image: this.limits.image, error: (v.stderr || v.error?.message || "docker not found").trim() };
    }
    const img = spawnSync(this.dockerBin, ["image", "inspect", this.limits.image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 5000 });
    return { available: true, version: v.stdout.trim(), imagePresent: img.status === 0, image: this.limits.image };
  }

  run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
    const timeoutMs = Math.min(opts.timeoutMs ?? this.limits.timeoutMs, 5 * 60_000);
    const name = `agentos-sbx-${randomUUID().slice(0, 12)}`;
    // Never run sandboxes as root: reuse the host user's uid on Linux (so workspace files stay
    // owned by them), otherwise the image's unprivileged `sandbox` user.
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const user = process.platform === "linux" && uid > 0 ? `${uid}:${process.getgid!()}` : "10001:10001";
    const args = [
      "run", "--rm", "-i", "--name", name,
      "--network", opts.network ?? "none",
      "--read-only",
      "--tmpfs", `/tmp:rw,nosuid,size=${opts.tmpfsMb ?? 64}m`,
      "--memory", `${this.limits.memoryMb}m`, "--memory-swap", `${this.limits.memoryMb}m`,
      "--cpus", this.limits.cpus,
      "--pids-limit", String(this.limits.pidsLimit),
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", user,
      "-v", `${opts.mountDir}:/workspace:rw`,
      "-w", "/workspace",
      "-e", "HOME=/tmp",
      "-e", "PYTHONPATH=/workspace/.packages/python",
      "-e", "NODE_PATH=/workspace/.packages/node/node_modules",
      "-e", "PYTHONUNBUFFERED=1",
      ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      this.limits.image,
      ...opts.argv
    ];

    return new Promise((resolve) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let done = false;
      const child = spawn(this.dockerBin, args, { stdio: ["pipe", "pipe", "pipe"] });
      const append = (which: "stdout" | "stderr", chunk: Buffer) => {
        const s = chunk.toString("utf8");
        opts.onOutput?.(which, s);
        if (which === "stdout") {
          if (stdout.length < MAX_OUTPUT) stdout += s;
          else truncated = true;
        } else {
          if (stderr.length < MAX_OUTPUT) stderr += s;
          else truncated = true;
        }
      };
      child.stdout.on("data", (c) => append("stdout", c));
      child.stderr.on("data", (c) => append("stderr", c));
      const timer = setTimeout(() => {
        timedOut = true;
        spawn(this.dockerBin, ["kill", name], { stdio: "ignore" }).on("error", () => {});
      }, timeoutMs + 2_000);
      const finish = (exitCode: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          stdout: stdout.slice(0, MAX_OUTPUT),
          stderr: stderr.slice(0, MAX_OUTPUT),
          exitCode,
          timedOut,
          durationMs: Date.now() - started,
          truncated
        });
      };
      child.on("error", (err) => {
        stderr += `Docker is not available: ${err.message}`;
        finish(null);
      });
      child.on("close", (code) => {
        if (code === 137 && !timedOut) stderr += `\n[sandbox] killed: memory limit ${this.limits.memoryMb}MB exceeded`;
        if (timedOut) stderr += `\n[sandbox] killed: exceeded ${timeoutMs}ms timeout`;
        finish(code);
      });
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  }
}
