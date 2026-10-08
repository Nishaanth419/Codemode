/**
 * Cloud Run sandbox executor.
 *
 * The generated JavaScript runs in Google's per-execution Cloud Run sandbox.
 * The only host capability passed into that sandbox is a read-only-mounted
 * Unix socket used to ask the parent process to call an approved MCP tool.
 * The sandbox is launched without --allow-egress and receives no host secrets.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface SandboxProvider {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
}

export interface SandboxResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

const EXECUTION_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 512_000;

const SANDBOX_RUNNER = String.raw`import net from "node:net";
const socketPath = "/workspace/mcp.sock";
const encodedCode = process.argv[2] || "";
const code = Buffer.from(encodedCode, "base64url").toString("utf8");
const logs = [];

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ name, args }) + "\n"));
    socket.on("data", (chunk) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        const message = JSON.parse(response.slice(0, newline));
        if (message.error) reject(new Error(message.error));
        else resolve(message.value);
      } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

const codemode = new Proxy(Object.create(null), {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    return (...args) => callTool(property, args[0] ?? {});
  }
});
const sandboxConsole = Object.fromEntries(["log", "info", "warn", "error"].map((level) => [
  level,
  (...values) => logs.push(values.map((value) => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(" "))
]));

try {
  const invoke = new Function("codemode", "console", "return (" + code + ")();");
  const result = await invoke(codemode, sandboxConsole);
  let serialized;
  try { serialized = JSON.stringify(result ?? null); }
  catch { serialized = JSON.stringify(String(result)); }
  process.stdout.write(JSON.stringify({ result: JSON.parse(serialized), logs }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error), logs }));
  process.exitCode = 1;
}`;

export class CloudRunSandboxExecutor {
  async execute(code: string, providers: SandboxProvider[]): Promise<SandboxResult> {
    const permittedTools = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    for (const provider of providers) {
      for (const [name, execute] of Object.entries(provider.fns)) {
        permittedTools.set(`${provider.name}.${name}`, execute);
      }
    }

    const directory = await mkdtemp(path.join(os.tmpdir(), "codemode-sandbox-"));
    const socketPath = path.join(directory, "mcp.sock");
    const runnerPath = path.join(directory, "runner.mjs");
    const encodedCode = Buffer.from(code, "utf8").toString("base64url");
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    const rpcServer = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (input.length > MAX_STDOUT_BYTES) {
          socket.end(`${JSON.stringify({ error: "Sandbox tool request exceeded the size limit." })}\n`);
          return;
        }
        if (!input.includes("\n")) return;
        socket.pause();
        void this.dispatchToolCall(input.slice(0, input.indexOf("\n")), permittedTools)
          .then((value) => {
            const serialized = JSON.stringify({ value });
            if (serialized.length > MAX_STDOUT_BYTES) {
              socket.end(`${JSON.stringify({ error: "MCP tool result exceeded the sandbox size limit." })}\n`);
            } else {
              socket.end(`${serialized}\n`);
            }
          })
          .catch((error: unknown) => socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`));
      });
    });

    try {
      await writeFile(runnerPath, SANDBOX_RUNNER, { mode: 0o400 });
      await new Promise<void>((resolve, reject) => {
        rpcServer.once("error", reject);
        rpcServer.listen(socketPath, resolve);
      });

      const sandbox = spawn("/usr/local/gcp/bin/sandbox", [
        "do",
        "--mount", `type=bind,source=${directory},destination=/workspace,readonly`,
        "--",
        process.execPath,
        "/workspace/runner.mjs",
        encodedCode,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          sandbox.kill("SIGKILL");
          reject(new Error(`Generated code exceeded the ${EXECUTION_TIMEOUT_MS / 1000}s execution limit.`));
        }, EXECUTION_TIMEOUT_MS);
        sandbox.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            sandbox.kill("SIGKILL");
            clearTimeout(timer);
            reject(new Error("Generated code returned more than 512 KB of output."));
            return;
          }
          stdout += chunk.toString("utf8");
        });
        sandbox.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(-4_000); });
        sandbox.once("error", (error) => { clearTimeout(timer); reject(error); });
        sandbox.once("close", (signalCode, signal) => {
          clearTimeout(timer);
          if (signal) reject(new Error(`Sandbox exited after signal ${signal}.`));
          else resolve(signalCode ?? 1);
        });
      });

      const output = JSON.parse(stdout) as SandboxResult;
      if (exitCode !== 0 && !output.error) output.error = stderr.trim() || `Sandbox exited with status ${exitCode}.`;
      return output;
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await new Promise<void>((resolve) => rpcServer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async dispatchToolCall(
    requestLine: string,
    permittedTools: Map<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<unknown> {
    const request = JSON.parse(requestLine) as { name?: unknown; args?: unknown };
    if (typeof request.name !== "string") throw new Error("Sandbox requested a tool without a name.");
    const execute = permittedTools.get(`codemode.${request.name}`);
    if (!execute) throw new Error(`Tool "${request.name}" is not available in this execution.`);
    return await execute(request.args ?? {});
  }
}
