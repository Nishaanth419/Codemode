/**
 * Dependency wiring. `createAppContext` builds every service from configuration;
 * tests pass overrides (mock fetch, in-memory DB, fake sandbox) through the same path.
 */
import path from "node:path";
import { AgentRunner } from "./agent/agent-runner.js";
import { EventBus } from "./agent/event-bus.js";
import { ExecutionRouter } from "./codemode/execution-router.js";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { createProviderRouter, type FetchLike, type LLMProvider, type ProviderName, type ProviderRouter } from "./providers/index.js";
import { DockerSandbox, type DockerStatus } from "./sandbox/docker.js";
import { PackageInstaller } from "./sandbox/packages.js";
import { WorkspaceManager } from "./sandbox/workspace.js";
import { createToolNamespaces, type NamespaceSpec } from "./tools/registry.js";

export interface AppContext {
  config: AppConfig;
  db: AppDatabase;
  bus: EventBus;
  router: ProviderRouter;
  executionRouter: ExecutionRouter;
  workspace: WorkspaceManager;
  sandbox: DockerSandbox;
  packages: PackageInstaller;
  namespaces: NamespaceSpec[];
  runner: AgentRunner;
  sandboxStatus: () => DockerStatus;
}

export interface AppOverrides {
  fetch?: FetchLike;
  providers?: Record<ProviderName, LLMProvider>;
  dbFile?: string;
  sandbox?: DockerSandbox;
  namespaces?: (ctx: Omit<AppContext, "namespaces" | "runner" | "sandboxStatus">) => NamespaceSpec[];
}

export function createAppContext(config: AppConfig, overrides: AppOverrides = {}): AppContext {
  const db = new AppDatabase(overrides.dbFile ?? path.join(config.DATA_DIR, "agentos.sqlite"));
  const bus = new EventBus(db);
  const router = createProviderRouter(config, { fetch: overrides.fetch, providers: overrides.providers });
  const executionRouter = new ExecutionRouter(config);
  const workspace = new WorkspaceManager(config.DATA_DIR, config.WORKSPACE_HOST_DIR);
  const sandbox =
    overrides.sandbox ??
    new DockerSandbox({
      image: config.SANDBOX_IMAGE,
      timeoutMs: config.SANDBOX_TIMEOUT_MS,
      memoryMb: config.SANDBOX_MEMORY_MB,
      cpus: config.SANDBOX_CPUS,
      pidsLimit: config.SANDBOX_PIDS_LIMIT
    });
  const packages = new PackageInstaller(sandbox, config.SANDBOX_ALLOWED_PACKAGES);
  const base = { config, db, bus, router, executionRouter, workspace, sandbox, packages };
  const namespaces = overrides.namespaces ? overrides.namespaces(base) : createToolNamespaces({ workspace, sandbox, packages });
  const runner = new AgentRunner({ db, router, executionRouter, namespaces, bus, maxSteps: config.LLM_MAX_AGENT_STEPS });

  let cached: { at: number; value: DockerStatus } | undefined;
  const sandboxStatus = () => {
    if (!cached || Date.now() - cached.at > 15_000) cached = { at: Date.now(), value: sandbox.status() };
    return cached.value;
  };

  return { ...base, namespaces, runner, sandboxStatus };
}
