// AgentOS Code Mode sandbox runtime.
//
// Runs one LLM-generated Code Mode program (an async arrow function, already
// normalized by @cloudflare/codemode's normalizeCode) inside a fresh V8 context.
// Tool calls such as `sandbox.runPython({...})` are forwarded to the host, which
// executes the real tool and sends back the JSON result.
//
// The same file is used by two executors:
//   - LocalWorkerExecutor: loaded in a node:worker_threads Worker (transport = parentPort)
//   - DockerExecutor:      run as `node codemode-runtime.mjs` in a locked-down container
//                          (transport = newline-delimited JSON over stdin/stdout)
//
// Isolation rules inside this file:
//   - The program only ever sees objects created inside the sandbox context.
//     Host functions are captured by a bootstrap closure and never exposed, and they
//     only exchange primitive strings/numbers, so host-realm constructors cannot leak.
//   - String code generation (eval / new Function) and WebAssembly are disabled.
//   - There is no require, import, process, fetch or filesystem in the context.
//   - The host enforces the wall-clock timeout by terminating the worker / container.

import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import { createInterface } from "node:readline";

/** @typedef {{ code: string, namespaces: { name: string, fns: string[] }[], syncTimeoutMs?: number }} StartMessage */

function createTransport() {
  if (parentPort) {
    return {
      start: Promise.resolve(/** @type {StartMessage} */ (workerData)),
      send: (msg) => parentPort.postMessage(msg),
      onMessage: (fn) => parentPort.on("message", fn),
      close: () => {}
    };
  }
  let resolveStart;
  const start = new Promise((r) => (resolveStart = r));
  const listeners = [];
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "start") resolveStart(msg);
    else for (const l of listeners) l(msg);
  });
  return {
    start,
    send: (msg) => process.stdout.write(JSON.stringify(msg) + "\n"),
    onMessage: (fn) => listeners.push(fn),
    close: () => {
      rl.close();
      // Flush the final message, then exit so pending sandbox timers cannot keep the container alive.
      process.stdout.write("", () => process.exit(0));
    }
  };
}

// Bootstrap evaluated inside the sandbox context. It receives the host bridge as an
// argument, keeps it in a closure, and installs sandbox-realm wrappers only.
const BOOTSTRAP = `(function (bridge, namespaces) {
  "use strict";
  const pending = new Map();
  const timers = new Map();
  let nextId = 1;

  function fmt(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || (v.name + ": " + v.message);
    if (typeof v === "undefined") return "undefined";
    if (typeof v === "function") return "[Function " + (v.name || "anonymous") + "]";
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function log(level) {
    return function () {
      const parts = [];
      for (let i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
      bridge.log(level, parts.join(" "));
    };
  }
  const consoleObj = {
    log: log("log"), info: log("info"), debug: log("debug"),
    warn: log("warn"), error: log("error")
  };
  Object.freeze(consoleObj);
  Object.defineProperty(globalThis, "console", { value: consoleObj, enumerable: false });

  function callTool(ns, name, args) {
    return new Promise(function (resolve, reject) {
      const id = String(nextId++);
      pending.set(id, { resolve: resolve, reject: reject });
      let argsJson;
      try { argsJson = JSON.stringify(args === undefined ? {} : args); }
      catch (e) { pending.delete(id); reject(new Error("Tool arguments must be JSON-serializable: " + e.message)); return; }
      bridge.call(id, String(ns), String(name), argsJson);
    });
  }

  for (const ns of namespaces) {
    const target = Object.create(null);
    for (const fn of ns.fns) {
      target[fn] = function (args) { return callTool(ns.name, fn, args); };
    }
    const proxy = new Proxy(target, {
      get: function (t, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in t) return t[prop];
        if (prop === "then") return undefined;
        return function (args) { return callTool(ns.name, prop, args); };
      }
    });
    Object.defineProperty(globalThis, ns.name, { value: proxy, enumerable: false });
  }

  function setTimeoutImpl(fn, ms) {
    const id = nextId++;
    timers.set(id, fn);
    bridge.timer(id, Math.max(0, Number(ms) || 0));
    return id;
  }
  function clearTimeoutImpl(id) { timers.delete(id); }
  Object.defineProperty(globalThis, "setTimeout", { value: setTimeoutImpl });
  Object.defineProperty(globalThis, "clearTimeout", { value: clearTimeoutImpl });

  // Host -> sandbox callbacks. Only primitives cross this boundary.
  return {
    resolve: function (id, ok, payload) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) {
        let value;
        try { value = payload === "" || payload === undefined ? undefined : JSON.parse(payload); }
        catch (e) { value = payload; }
        p.resolve(value);
      } else {
        p.reject(new Error(String(payload)));
      }
    },
    fire: function (id) {
      const fn = timers.get(id);
      if (!fn) return;
      timers.delete(id);
      try { fn(); } catch (e) { consoleObj.error(e); }
    },
    run: function (program) {
      Promise.resolve()
        .then(function () { return program(); })
        .then(function (result) {
          let json;
          try { json = JSON.stringify(result === undefined ? null : result); }
          catch (e) { json = JSON.stringify(String(result)); }
          bridge.done(true, json === undefined ? "null" : json);
        }, function (err) {
          const msg = err instanceof Error ? (err.message || String(err)) : fmt(err);
          bridge.done(false, msg);
        });
    }
  };
})`;

async function main() {
  const transport = createTransport();
  const start = await transport.start;
  const syncTimeoutMs = start.syncTimeoutMs ?? 10_000;

  let finished = false;
  const finish = (msg) => {
    if (finished) return;
    finished = true;
    transport.send(msg);
    transport.close();
  };

  const context = vm.createContext(Object.create(null), {
    name: "agentos-codemode",
    codeGeneration: { strings: false, wasm: false }
  });

  // Host bridge: functions never throw and only accept primitive arguments.
  const bridge = Object.freeze({
    log(level, line) {
      try {
        if (typeof line !== "string") return;
        transport.send({ type: "log", level: typeof level === "string" ? level : "log", line: line.slice(0, 20_000) });
      } catch {}
    },
    call(id, ns, name, argsJson) {
      try {
        if (typeof id !== "string" || typeof ns !== "string" || typeof name !== "string" || typeof argsJson !== "string") return;
        transport.send({ type: "tool-call", id, namespace: ns, name, args: argsJson });
      } catch {}
    },
    timer(id, ms) {
      try {
        if (typeof id !== "number" || typeof ms !== "number") return;
        setTimeout(() => {
          try {
            sandboxApi.fire(id);
          } catch {}
        }, Math.min(ms, 60_000));
      } catch {}
    },
    done(ok, payload) {
      try {
        finish(ok === true ? { type: "done", ok: true, result: String(payload) } : { type: "done", ok: false, error: String(payload) });
      } catch {}
    }
  });

  let sandboxApi;
  try {
    const bootstrap = vm.runInContext(BOOTSTRAP, context, { filename: "bootstrap.js" });
    // Pass namespaces as a JSON string so the sandbox parses its own copy.
    const namespaces = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(start.namespaces))})`, context);
    sandboxApi = bootstrap(bridge, namespaces);
  } catch (err) {
    finish({ type: "done", ok: false, error: `Sandbox bootstrap failed: ${err?.message ?? err}` });
    return;
  }

  transport.onMessage((msg) => {
    if (msg?.type === "tool-result" && typeof msg.id === "string") {
      sandboxApi.resolve(msg.id, msg.ok === true, msg.ok === true ? String(msg.result ?? "") : String(msg.error ?? "Tool failed"));
    }
  });

  let program;
  try {
    program = vm.runInContext(`(${start.code})`, context, {
      filename: "codemode-program.js",
      timeout: syncTimeoutMs
    });
  } catch (err) {
    finish({ type: "done", ok: false, error: `${err?.name ?? "Error"}: ${err?.message ?? err}` });
    return;
  }
  if (typeof program !== "function") {
    finish({ type: "done", ok: false, error: "Code Mode program must evaluate to an async arrow function" });
    return;
  }
  try {
    sandboxApi.run(program);
  } catch (err) {
    finish({ type: "done", ok: false, error: `${err?.message ?? err}` });
  }
}

main().catch((err) => {
  try {
    const msg = { type: "done", ok: false, error: `Runtime failure: ${err?.message ?? err}` };
    if (parentPort) parentPort.postMessage(msg);
    else process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {}
});
