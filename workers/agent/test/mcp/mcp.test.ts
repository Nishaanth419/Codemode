/**
 * MCP support: config, MCP tools → TypeScript API, execution from Code Mode programs,
 * failure handling and credential isolation. No network: the test MCP server runs
 * in-process (InMemoryTransport), as a stdio child process, or on 127.0.0.1.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Executor } from "@cloudflare/codemode";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAppContext } from "../../src/app.js";
import { buildCodeToolDefinition, executeCodeMode, namespaceTypes } from "../../src/codemode/code-tool.js";
import { DockerExecutor, LocalWorkerExecutor } from "../../src/codemode/executors.js";
import { loadConfig } from "../../src/config.js";
import { loadMcpServers, type McpServerConfig } from "../../src/mcp/config.js";
import { McpManager } from "../../src/mcp/manager.js";
import { resolveNamespace } from "../../src/mcp/namespace.js";
import { createServer } from "../../src/server.js";
import type { NamespaceSpec } from "../../src/tools/registry.js";
import { createToolNamespaces } from "../../src/tools/registry.js";
import { makeAgent, testConfig } from "../helpers/harness.js";
import { MockLLM } from "../helpers/mock-llm.js";
// @ts-expect-error plain ESM fixture without type declarations
import { createTestServer, startHttpTestServer } from "./fixtures/test-server.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/test-server.mjs", import.meta.url));
const config = loadConfig({});
const ctx = { sessionId: "ses_mcp", runId: "run_mcp", executionId: "exec_mcp" };
const local = new LocalWorkerExecutor({ runtimePath: config.CODEMODE_RUNTIME_PATH, timeoutMs: 5_000 });
const dockerOk = spawnSync("docker", ["image", "inspect", config.SANDBOX_IMAGE], { stdio: "ignore", timeout: 5000 }).status === 0;

const OPTS = { connectTimeoutMs: 10_000, callTimeoutMs: 5_000, reconnectMaxMs: 50 };

const servers = (json: unknown, env: NodeJS.ProcessEnv = {}) =>
  loadMcpServers({ inline: JSON.stringify(json), baseDir: process.cwd(), env });

/** Transport factory that connects each attempt to a fresh in-process test server. */
function inMemory() {
  const live: { server: McpServer; transport: InMemoryTransport }[] = [];
  return {
    live,
    createTransport: async () => {
      const [client, serverSide] = InMemoryTransport.createLinkedPair();
      const server: McpServer = createTestServer();
      await server.connect(serverSide);
      live.push({ server, transport: serverSide });
      return client;
    }
  };
}

const managers: McpManager[] = [];
async function connectedManager(cfg: McpServerConfig[] = servers({ mcpServers: { "test-server": { command: "in-memory", namespace: "weather" } } })) {
  const mem = inMemory();
  const manager = new McpManager(cfg, { ...OPTS, createTransport: mem.createTransport });
  managers.push(manager);
  await manager.start();
  return { manager, mem, ns: manager.namespaces()[0] as NamespaceSpec };
}

const run = (code: string, namespaces: NamespaceSpec[], executor: Executor = local) => executeCodeMode({ code, executor, namespaces, ctx });

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

describe("MCP config", () => {
  it("reads the mcpServers format and a plain server map, stdio and Streamable HTTP", () => {
    const a = servers({ mcpServers: { local: { command: "npx", args: ["-y", "pkg"] }, remote: { url: "https://mcp.example.com/mcp" } } });
    expect(a.map((s) => [s.name, s.transport, s.display])).toEqual([
      ["local", "stdio", "npx -y pkg"],
      ["remote", "http", "https://mcp.example.com/mcp"]
    ]);
    expect(servers({ local: { command: "node" } })[0]).toMatchObject({ name: "local", transport: "stdio", enabled: true, args: [] });
  });

  it("fills ${VAR} placeholders from the environment and never displays their values", () => {
    const [s] = servers(
      { gh: { url: "https://api.example.com/mcp?key=${KEY}", headers: { Authorization: "Bearer ${TOKEN}" } } },
      { TOKEN: "tok_123", KEY: "k_456" }
    );
    expect(s).toMatchObject({ transport: "http", url: "https://api.example.com/mcp?key=k_456", headers: { Authorization: "Bearer tok_123" } });
    expect(s.display).toBe("https://api.example.com/mcp");
    expect(JSON.stringify(s.display)).not.toMatch(/tok_123|k_456/);
  });

  it("marks a server with an unset variable as failed instead of stopping startup", () => {
    const [s] = servers({ gh: { command: "gh-mcp", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } });
    expect(s.error).toMatch(/GITHUB_TOKEN not set/);
  });

  it("rejects malformed config with a clear error", () => {
    expect(() => servers({ bad: { args: ["x"] } })).toThrow(/command|url/);
    expect(() => loadMcpServers({ inline: "{not json", baseDir: ".", env: {} })).toThrow(/MCP_SERVERS: invalid JSON/);
    expect(() => loadConfig({ MCP_SERVERS: '{"x": {"command": 1}}' })).toThrow(/Invalid configuration/);
  });

  it("loads MCP_CONFIG_FILE relative to the repo root, and MCP_SERVERS overrides entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-mcp-"));
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { command: "one" }, b: { command: "two" } } }));
    const cfg = loadConfig({ MCP_CONFIG_FILE: file, MCP_SERVERS: JSON.stringify({ b: { url: "http://127.0.0.1:1/mcp" } }) });
    expect(cfg.mcpServers.map((s) => `${s.name}:${s.transport}`)).toEqual(["a:stdio", "b:http"]);
  });

  it("sanitizes namespaces and refuses reserved or duplicate ones", async () => {
    expect(resolveNamespace("server-everything")).toEqual({ namespace: "server_everything" });
    expect(resolveNamespace("my.docs")).toEqual({ namespace: "my_docs" });
    expect(resolveNamespace("web").error).toMatch(/reserved/);
    expect(resolveNamespace("JSON").error).toMatch(/reserved/);
    const m = new McpManager(servers({ "a-b": { command: "x" }, a_b: { command: "y" }, sandbox: { command: "z" } }), OPTS);
    const status = m.status();
    expect(status[0]).toMatchObject({ namespace: "a_b", state: "connecting" });
    expect(status[1]).toMatchObject({ state: "error", error: expect.stringMatching(/already used by MCP server "a-b"/) });
    expect(status[2]).toMatchObject({ state: "error", error: expect.stringMatching(/reserved/) });
  });
});

describe("MCP tools → TypeScript API", () => {
  it("builds one namespace per server and maps sanitized names back to the MCP names", async () => {
    const { ns, manager } = await connectedManager();
    expect(ns).toMatchObject({ name: "weather", source: "mcp", server: "test-server" });
    const mapping = Object.fromEntries(Object.entries(ns.tools).map(([k, t]) => [k, t.mcpName]));
    expect(mapping).toEqual({
      get_forecast: "get-forecast",
      add: "add",
      files_list: "files.list",
      always_fails: "always-fails",
      print_env: "print-env",
      slow: "slow"
    });
    expect(manager.status()[0]).toMatchObject({ state: "connected", toolCount: 6, server: { name: "agentos-test-server", version: "1.2.3" } });
  });

  it("generates TypeScript from inputSchema / outputSchema, with McpToolResult when there is no output schema", async () => {
    const { ns } = await connectedManager();
    const types = namespaceTypes(ns);
    expect(types).toContain(`Tools from the MCP server "test-server" (agentos-test-server 1.2.3)`);
    expect(types).toContain("Weather and arithmetic for AgentOS tests.");
    expect(types).toMatch(/type GetForecastInput = \{\s+\/\*\* City name \*\/\s+city: string;\s+days\?: number;\s+\}/);
    expect(types).toMatch(/type GetForecastOutput = \{\s+city: string;\s+tempC: number;\s+conditions: "sunny" \| "rain";\s+\}/);
    expect(types).toContain("type AddOutput = McpToolResult");
    expect(types).toContain("type McpToolResult = string | number | boolean | null | unknown[]");
    expect(types).toContain("declare const weather: {");
    expect(types).toContain("get_forecast: (input: GetForecastInput) => Promise<GetForecastOutput>;");
    expect(types).toContain("files_list: (input: FilesListInput) => Promise<FilesListOutput>;");

    // In the codemode tool description the shared McpToolResult type is declared once.
    const def = buildCodeToolDefinition([...createToolNamespaces({} as never), ns, { ...ns, name: "weather2" }]);
    expect(def.description.match(/type McpToolResult =/g)).toHaveLength(1);
    expect(def.description).toContain("declare const weather2: {");
  });
});

describe("calling MCP tools from programs", () => {
  it("returns structuredContent, parsed JSON text and plain text", async () => {
    const { ns } = await connectedManager();
    const out = await run(
      `async () => {
        const f = await weather.get_forecast({ city: "Oslo" });
        const sum = await weather.add({ a: 2, b: 3 });
        const files = await weather.files_list({});
        return { f, sum, names: files.map((x) => x.name) };
      }`,
      [ns]
    );
    expect(out).toMatchObject({ ok: true, result: { f: { city: "Oslo", tempC: 12, conditions: "sunny" }, sum: "The sum is 5", names: ["a.txt", "b.txt"] } });
  });

  it("turns isError results into exceptions the program can catch", async () => {
    const { ns } = await connectedManager();
    const caught = await run(`async () => { try { await weather.always_fails({}); return "no"; } catch (e) { return e.message; } }`, [ns]);
    expect(caught).toMatchObject({ ok: true, result: "test-server/always-fails: upstream exploded" });
    const uncaught = await run(`async () => weather.always_fails({})`, [ns]);
    expect(uncaught).toMatchObject({ ok: false, error: expect.stringContaining("upstream exploded") });
  });

  it("validates arguments against the MCP input schema before calling the server", async () => {
    const { ns } = await connectedManager();
    const out = await run(`async () => weather.get_forecast({ days: 2 })`, [ns]);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('weather.get_forecast: missing required argument "city"') });
  });

  it("applies the per-call timeout and reports transport errors as thrown errors", async () => {
    const cfg = servers({ t: { command: "in-memory", timeoutMs: 100 } });
    const { ns } = await connectedManager(cfg);
    const out = await run(`async () => t.slow({ ms: 2000 })`, [ns]);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/t\/slow: .*timed out/i) });
  });

  it("codemode.searchTools finds MCP tools with their server and real MCP name", async () => {
    const { ns } = await connectedManager();
    const builtins = createToolNamespaces({} as never);
    const out = await run(`async () => (await codemode.searchTools({ query: "forecast" })).tools`, [...builtins, ns]);
    expect(out.result).toEqual([
      { name: "weather.get_forecast", description: "Get the forecast for a city", mcpServer: "test-server", mcpTool: "get-forecast" }
    ]);
  });

  it("runs end to end through the agent loop: one program calls the MCP API", async () => {
    const { ns } = await connectedManager();
    const code = `async () => {
      const f = await weather.get_forecast({ city: "Lima" });
      const s = await weather.add({ a: f.tempC, b: 1 });
      return { forecast: f, note: s };
    }`;
    const mock = new MockLLM().groq({ kind: "tool", code }, { kind: "text", text: "Lima: 12°C" });
    const agent = makeAgent(mock, { namespaces: [ns] });
    const outcome = await agent.runner.run("ses_mcp_run", "run_mcp_run", "weather in Lima?");
    expect(outcome).toMatchObject({ status: "completed", text: "Lima: 12°C" });

    // The LLM saw exactly one tool, with the MCP API in its description, and the prompt names the server.
    const first = mock.calls("groq")[0].body;
    expect(first.tools.map((t: any) => t.function.name)).toEqual(["codemode"]);
    expect(first.tools[0].function.description).toContain("declare const weather: {");
    expect(first.messages[0].content).toContain('`weather.*` calls the 6 tools of the MCP server "test-server"');

    const calls = agent.types("tool.result").map((e) => `${e.data.namespace}.${e.data.tool}:${e.data.ok}`);
    expect(calls).toEqual(["weather.get_forecast:true", "weather.add:true"]);
    const [exec] = agent.db.listExecutions("ses_mcp_run");
    expect(JSON.parse(exec.result!)).toEqual({ forecast: { city: "Lima", tempC: 12, conditions: "sunny" }, note: "The sum is 13" });
  });

  it.skipIf(!dockerOk)("works the same with the Docker executor", async () => {
    const { ns } = await connectedManager();
    const docker = new DockerExecutor({ image: config.SANDBOX_IMAGE, timeoutMs: 10_000 });
    const out = await run(`async () => (await weather.get_forecast({ city: "Rome" })).tempC`, [ns], docker);
    expect(out).toMatchObject({ ok: true, result: 12 });
  }, 60_000);
});

describe("MCP server lifecycle", () => {
  it("a server that cannot start is reported, retried, and does not block the others", async () => {
    const mem = inMemory();
    const cfg = servers({
      broken: { command: path.join(os.tmpdir(), "agentos-no-such-mcp-binary") },
      ok: { command: "in-memory" }
    });
    const manager = new McpManager(cfg, {
      ...OPTS,
      // Only "ok" is in-memory; "broken" uses the real stdio transport.
      createTransport: (s) => (s.name === "ok" ? mem.createTransport() : undefined)
    });
    managers.push(manager);
    await manager.start();
    const [broken, ok] = manager.status();
    expect(broken).toMatchObject({ state: "error", error: expect.stringMatching(/ENOENT|not found|spawn/i), failures: 1 });
    expect(broken.nextRetryAt).not.toBeNull();
    expect(ok).toMatchObject({ state: "connected", toolCount: 6 });
    expect(manager.namespaces().map((n) => n.name)).toEqual(["ok"]);
  });

  it("reconnects after the server drops, and calls fail clearly while it is down", async () => {
    const { manager, mem, ns } = await connectedManager();
    await mem.live[0].transport.close();
    await waitFor(() => manager.status()[0].state !== "connected");
    const down = await run(`async () => weather.add({ a: 1, b: 1 })`, [ns]);
    expect(down).toMatchObject({ ok: false, error: expect.stringMatching(/not connected/) });
    await waitFor(() => manager.status()[0].state === "connected");
    expect(mem.live).toHaveLength(2);
    const again = await run(`async () => weather.add({ a: 1, b: 1 })`, [manager.namespaces()[0]]);
    expect(again).toMatchObject({ ok: true, result: "The sum is 2" });
  });

  it("picks up tools/list_changed notifications", async () => {
    const { manager, mem } = await connectedManager();
    mem.live[0].server.registerTool("late-tool", { description: "Registered after connect" }, async () => ({ content: [{ type: "text", text: "late" }] }));
    await waitFor(() => "late_tool" in (manager.namespaces()[0]?.tools ?? {}));
    expect(manager.namespaces()[0].tools.late_tool.mcpName).toBe("late-tool");
  });

  it("connects to a real stdio server process", async () => {
    const manager = new McpManager(servers({ stdio: { command: process.execPath, args: [FIXTURE] } }), OPTS);
    managers.push(manager);
    await manager.start();
    expect(manager.status()[0]).toMatchObject({ state: "connected", transport: "stdio", toolCount: 6 });
    const out = await run(`async () => stdio.get_forecast({ city: "Kyiv" })`, manager.namespaces());
    expect(out).toMatchObject({ ok: true, result: { city: "Kyiv", tempC: 12 } });
  });
});

describe("credential isolation", () => {
  const SECRET = "s3cret-mcp-token-0f9e";
  let http: Awaited<ReturnType<typeof startHttpTestServer>>;
  afterAll(async () => http?.close());

  it("HTTP headers stay in the agent: the server gets them, the program and the API never see them", async () => {
    http = await startHttpTestServer(SECRET);
    const cfg = servers({ secure: { url: http.url, headers: { Authorization: "Bearer ${SECURE_TOKEN}" } } }, { SECURE_TOKEN: SECRET });
    const manager = new McpManager(cfg, OPTS);
    managers.push(manager);
    await manager.start();
    expect(manager.status()[0]).toMatchObject({ state: "connected", transport: "http" });
    expect(http.seenAuth.every((h: string | null) => h === `Bearer ${SECRET}`)).toBe(true);

    const ns = manager.namespaces()[0];
    const probe = await run(
      `async () => {
        const seen = { globals: Object.getOwnPropertyNames(globalThis), keys: Object.keys(secure) };
        seen.typeofClient = typeof secure.client;
        try { await secure.client({}); } catch (e) { seen.clientCall = e.message; }
        try { seen.ctor = String(secure.get_forecast.constructor("return this")()); } catch (e) { seen.ctor = e.message; }
        seen.forecast = await secure.get_forecast({ city: "Bern" });
        return seen;
      }`,
      [ns]
    );
    expect(probe.error).toBeUndefined();
    const r = probe.result as any;
    expect(r.forecast).toMatchObject({ city: "Bern" });
    expect(r.clientCall).toMatch(/Tool "secure.client" does not exist/);
    expect(r.ctor).toMatch(/Code generation from strings disallowed/);
    expect(r.globals).not.toContain("process");
    expect(JSON.stringify(probe)).not.toContain(SECRET);

    // Status, tool catalog and the tool definition sent to the LLM don't contain it either.
    expect(JSON.stringify(manager.status())).not.toContain(SECRET);
    expect(buildCodeToolDefinition([ns]).description).not.toContain(SECRET);
  });

  it("an HTTP server rejecting the credentials is reported as failed", async () => {
    http ??= await startHttpTestServer(SECRET);
    const manager = new McpManager(servers({ secure: { url: http.url, headers: { Authorization: "Bearer wrong" } } }), OPTS);
    managers.push(manager);
    await manager.start();
    expect(manager.status()[0]).toMatchObject({ state: "error", error: expect.stringMatching(/401|unauthorized/i) });
    expect(manager.status()[0].error).not.toContain("wrong");
  });

  it("stdio servers get only the minimal default environment plus their own env, never the agent's keys", async () => {
    process.env.AGENTOS_TEST_LLM_KEY = "gsk_should_not_leak";
    try {
      const manager = new McpManager(
        servers({ envcheck: { command: process.execPath, args: [FIXTURE], env: { SERVER_ONLY_VAR: "1" } } }),
        OPTS
      );
      managers.push(manager);
      await manager.start();
      const out = await run(`async () => envcheck.print_env({})`, manager.namespaces());
      expect(out.ok).toBe(true);
      expect(out.result).toContain("SERVER_ONLY_VAR");
      expect(out.result).toContain("PATH");
      expect(out.result).not.toContain("AGENTOS_TEST_LLM_KEY");
    } finally {
      delete process.env.AGENTOS_TEST_LLM_KEY;
    }
  });
});

describe("agent app with MCP", () => {
  it("starts with a failed server, serves MCP status and tools, and runs programs against the healthy one", async () => {
    const mem = inMemory();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-mcp-app-"));
    const mcpServers = [
      ...servers({ weather: { command: "in-memory" } }),
      ...servers({ down: { url: "http://127.0.0.1:9/mcp?token=${DOWN_TOKEN}", headers: { "X-Key": "${DOWN_TOKEN}" } } }, { DOWN_TOKEN: "dt_secret_77" })
    ];
    const mock = new MockLLM().groq(
      { kind: "tool", code: "async () => { const f = await weather.get_forecast({ city: 'Paris' }); return f.conditions; }" },
      { kind: "text", text: "rain" }
    );
    const app = createAppContext(testConfig({ GROQ_API_KEY: "gsk_test", DATA_DIR: dataDir, mcpServers }), {
      fetch: mock.fetch,
      dbFile: ":memory:",
      // "down" uses the real HTTP transport and fails to connect.
      mcpTransport: (s) => (s.name === "weather" ? mem.createTransport() : undefined)
    });
    const listener = createServer(app).listen(0, "127.0.0.1");
    try {
      await new Promise((r) => listener.once("listening", r));
      const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
      await app.mcp.start();

      const status: any = await (await fetch(`${base}/api/status`)).json();
      expect(status.mcp.servers.map((s: any) => [s.name, s.state])).toEqual([
        ["weather", "connected"],
        ["down", "error"]
      ]);
      expect(status.mcp.servers[1].target).toBe("http://127.0.0.1:9/mcp");

      const tools: any = await (await fetch(`${base}/api/tools`)).json();
      const weather = tools.namespaces.find((n: any) => n.name === "weather");
      expect(weather).toMatchObject({ source: "mcp", server: "weather" });
      expect(weather.tools.find((t: any) => t.name === "get_forecast").mcpName).toBe("get-forecast");
      expect(weather.types).toContain("declare const weather: {");
      expect(tools.namespaces.map((n: any) => n.name)).toEqual(["fs", "sandbox", "web", "codemode", "weather"]);
      expect(JSON.stringify([status, tools])).not.toContain("dt_secret_77");

      const outcome = await app.runner.start("ses_app", "Paris?").done;
      expect(outcome).toMatchObject({ status: "completed", text: "rain" });
      expect(app.db.listExecutions("ses_app")[0]).toMatchObject({ status: "completed", result: '"rain"' });
    } finally {
      listener.close();
      await app.mcp.close();
      app.db.close();
    }
  });
});

async function waitFor(cond: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
