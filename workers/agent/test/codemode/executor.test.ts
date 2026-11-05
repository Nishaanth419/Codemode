import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCode } from "@cloudflare/codemode";
import { buildCodeToolDefinition, executeCodeMode } from "../../src/codemode/code-tool.js";
import { DockerExecutor, LocalWorkerExecutor } from "../../src/codemode/executors.js";
import { loadConfig } from "../../src/config.js";
import { DockerSandbox } from "../../src/sandbox/docker.js";
import { PackageInstaller } from "../../src/sandbox/packages.js";
import { WorkspaceManager } from "../../src/sandbox/workspace.js";
import { createToolNamespaces, validateArgs } from "../../src/tools/registry.js";
import { counterNamespace } from "../helpers/harness.js";

const config = loadConfig({});
const local = new LocalWorkerExecutor({ runtimePath: config.CODEMODE_RUNTIME_PATH, timeoutMs: 1500 });
const providers = [{ name: "math", fns: { add: async (a: any) => ({ sum: a.a + a.b }) } }];
const run = (code: string) => runCode({ code, executor: local, providers });

const dockerOk =
  spawnSync("docker", ["image", "inspect", config.SANDBOX_IMAGE], { stdio: "ignore", timeout: 5000 }).status === 0;

describe("LocalWorkerExecutor (Code Mode Executor contract)", () => {
  it("runs generated JavaScript, dispatches tool calls and captures logs", async () => {
    const out = await run("async () => { const r = await math.add({a: 2, b: 3}); console.log('sum', r.sum); return { doubled: r.sum * 2 }; }");
    expect(out).toEqual({ result: { doubled: 10 }, logs: ["sum 5"] });
  });

  it("accepts the code shapes normalizeCode supports (bare statements, fences)", async () => {
    expect((await run("```js\nconst r = await math.add({a:1,b:1});\nr.sum\n```")).result).toBe(2);
  });

  it.each([
    ["Function constructor via this", "async () => this.constructor.constructor('return process')()"],
    ["Function constructor via tool fn", "async () => math.add.constructor('return process')()"],
    ["eval", "async () => eval('1')"],
    ["Promise constructor chain", "async () => math.add({a:1,b:1}).constructor.constructor('return 1')()"]
  ])("blocks sandbox escape: %s", async (_name, code) => {
    await expect(run(code)).rejects.toThrow(/Code generation from strings disallowed/);
  });

  it("exposes no host globals", async () => {
    expect((await run("async () => [typeof process, typeof require, typeof fetch, typeof globalThis.Buffer].join()")).result).toBe(
      "undefined,undefined,undefined,undefined"
    );
  });

  it("kills infinite loops at the timeout", async () => {
    await expect(run("async () => { await math.add({a:1,b:1}); while (true) {} }")).rejects.toThrow(/timed out after 1500ms/);
  });

  it("enforces the heap limit", async () => {
    const tiny = new LocalWorkerExecutor({ runtimePath: config.CODEMODE_RUNTIME_PATH, timeoutMs: 10_000, memoryMb: 16 });
    const r = await tiny.execute("async () => { const a = []; while (true) a.push(new Array(1e6).fill(1)); }", providers);
    expect(r.error).toMatch(/memory|heap|exited/i);
  });

  it("reports unknown tools and thrown errors", async () => {
    await expect(run("async () => math.nope({})")).rejects.toThrow(/Tool "math.nope" does not exist/);
    await expect(run("async () => { throw new Error('boom') }")).rejects.toThrow(/boom/);
  });
});

describe.skipIf(!dockerOk)("DockerExecutor", () => {
  it("runs the same runtime inside a locked-down container", async () => {
    const docker = new DockerExecutor({ image: config.SANDBOX_IMAGE, timeoutMs: 5000 });
    const out = await runCode({ code: "async () => (await math.add({a: 40, b: 2})).sum", executor: docker, providers });
    expect(out.result).toBe(42);
  });
});

describe("Code Mode tool definition", () => {
  it("generates TypeScript declarations per namespace from JSON Schema", () => {
    const def = buildCodeToolDefinition([counterNamespace().ns]);
    expect(def.name).toBe("codemode");
    expect(def.description).toContain("declare const math:");
    expect(def.description).toContain("add: (input: AddInput) => Promise<AddOutput>;");
    expect(def.parameters).toMatchObject({ required: ["code"] });
  });

  it("validates tool arguments before running a tool", () => {
    const schema = { type: "object", properties: { a: { type: "number" }, m: { type: "string", enum: ["pip", "npm"] } }, required: ["a"] };
    expect(() => validateArgs("t", schema, {})).toThrow(/missing required argument "a"/);
    expect(() => validateArgs("t", schema, { a: "1" })).toThrow(/must be number/);
    expect(() => validateArgs("t", schema, { a: 1, m: "apt" })).toThrow(/one of pip, npm/);
  });
});

describe("workspace and file tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-ws-"));
  const ws = new WorkspaceManager(dir);

  it("blocks path traversal and symlink escapes", async () => {
    await ws.ensure("ses_a");
    expect(() => ws.resolve("ses_a", "../../etc/passwd")).toThrow(/outside the workspace/);
    fs.symlinkSync("/etc", path.join(ws.dirFor("ses_a"), "link"));
    expect(() => ws.resolve("ses_a", "link/passwd")).toThrow(/outside the workspace/);
    expect(() => ws.dirFor("../x")).toThrow(/Invalid session id/);
  });

  it("fs tools write and read through a Code Mode program", async () => {
    const sandbox = new DockerSandbox({ image: config.SANDBOX_IMAGE, timeoutMs: 5000, memoryMb: 128, cpus: "0.5", pidsLimit: 32 });
    const namespaces = createToolNamespaces({ workspace: ws, sandbox, packages: new PackageInstaller(sandbox, "") });
    const outcome = await executeCodeMode({
      code: "async () => { await fs.writeFile({ path: 'out/report.md', content: '# hi' }); const r = await fs.readFile({ path: 'out/report.md' }); const l = await fs.listFiles({}); return { content: r.content, files: l.files.map(f => f.path) }; }",
      executor: local,
      namespaces,
      ctx: { sessionId: "ses_b", runId: "r", executionId: "e" }
    });
    expect(outcome).toMatchObject({ ok: true, result: { content: "# hi", files: ["out/report.md"] } });
  });

  it("package installs are restricted to the allowlist", () => {
    const pk = new PackageInstaller({} as DockerSandbox, "pip:requests,npm:lodash");
    expect(pk.check("pip", "requests")).toEqual({ ok: true });
    expect(pk.check("pip", "evil-pkg")).toMatchObject({ ok: false, reason: expect.stringContaining("allowlist") });
    expect(pk.check("pip", "requests; rm -rf /")).toMatchObject({ ok: false, reason: expect.stringContaining("Invalid package name") });
    expect(pk.check("apt", "curl")).toMatchObject({ ok: false });
    expect(pk.check("npm", "lodash", "4.17.21")).toEqual({ ok: true });
    expect(pk.check("npm", "lodash", "latest && curl x")).toMatchObject({ ok: false });
  });
});

describe.skipIf(!dockerOk)("Docker sandbox (Python / Node / shell)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-sbx-"));
  const ws = new WorkspaceManager(dir);
  const sandbox = new DockerSandbox({ image: config.SANDBOX_IMAGE, timeoutMs: 8000, memoryMb: 128, cpus: "0.5", pidsLimit: 32 });
  const namespaces = createToolNamespaces({ workspace: ws, sandbox, packages: new PackageInstaller(sandbox, "") });
  const exec = (code: string) =>
    executeCodeMode({ code, executor: new LocalWorkerExecutor({ runtimePath: config.CODEMODE_RUNTIME_PATH, timeoutMs: 30_000 }), namespaces, ctx: { sessionId: "ses_d", runId: "r", executionId: "e" } });

  it("runs Python, Node and shell in containers sharing the workspace", async () => {
    const out = await exec(`async () => {
      const py = await sandbox.runPython({ code: "open('/workspace/a.txt','w').write(str(sum(range(10))))\\nprint('py ok')" });
      const node = await sandbox.runNode({ code: "console.log(require('fs').readFileSync('/workspace/a.txt','utf8'))" });
      const sh = await sandbox.runShell({ command: "wc -c < a.txt" });
      return { py: py.stdout.trim(), node: node.stdout.trim(), sh: sh.stdout.trim() };
    }`);
    expect(outcome(out)).toEqual({ py: "py ok", node: "45", sh: "2" });
  }, 60_000);

  it("has no network and a read-only root filesystem", async () => {
    const out = await exec(`async () => {
      const net = await sandbox.runPython({ code: "import urllib.request\\ntry:\\n  urllib.request.urlopen('http://example.com', timeout=3)\\n  print('online')\\nexcept Exception as e:\\n  print('offline')" });
      const ro = await sandbox.runShell({ command: "touch /usr/x 2>&1 || echo readonly" });
      return { net: net.stdout.trim(), ro: ro.stdout.trim().split('\\n').pop() };
    }`);
    expect(outcome(out)).toEqual({ net: "offline", ro: "readonly" });
  }, 60_000);

  it("kills runaway processes at the timeout", async () => {
    const out = await exec(`async () => sandbox.runShell({ command: "sleep 30", timeoutMs: 1000 })`);
    expect(outcome(out)).toMatchObject({ timedOut: true });
  }, 60_000);
});

function outcome(o: { ok: boolean; result?: unknown; error?: string }) {
  if (!o.ok) throw new Error(o.error);
  return o.result;
}
