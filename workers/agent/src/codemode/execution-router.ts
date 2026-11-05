/**
 * Execution router: chooses the Code Mode executor from CODEMODE_EXECUTOR.
 *
 *   local  → LocalWorkerExecutor (development adapter, default)
 *   docker → DockerExecutor (container isolation)
 *
 * Cloudflare's managed DynamicWorkerExecutor is intentionally not offered here: it
 * requires the Workers runtime and a Worker Loader binding. Both local executors
 * implement the same @cloudflare/codemode `Executor` interface, so deploying AgentOS
 * as a Worker later means swapping this factory, not the agent.
 */
import type { Executor } from "@cloudflare/codemode";
import type { AppConfig } from "../config.js";
import { DockerExecutor, LocalWorkerExecutor, type ExecutorHooks, type ExecutorInfo } from "./executors.js";

export class ExecutionRouter {
  constructor(private readonly config: AppConfig) {}

  get info(): ExecutorInfo {
    return this.config.CODEMODE_EXECUTOR === "docker" ? DockerExecutor.info : LocalWorkerExecutor.info;
  }

  create(hooks: ExecutorHooks = {}): Executor {
    if (this.config.CODEMODE_EXECUTOR === "docker") {
      return new DockerExecutor({
        image: this.config.SANDBOX_IMAGE,
        timeoutMs: this.config.CODEMODE_TIMEOUT_MS,
        maxWallMs: this.config.CODEMODE_MAX_WALL_MS,
        memoryMb: this.config.CODEMODE_MEMORY_MB,
        cpus: this.config.SANDBOX_CPUS,
        pidsLimit: this.config.SANDBOX_PIDS_LIMIT,
        ...hooks
      });
    }
    return new LocalWorkerExecutor({
      runtimePath: this.config.CODEMODE_RUNTIME_PATH,
      timeoutMs: this.config.CODEMODE_TIMEOUT_MS,
      maxWallMs: this.config.CODEMODE_MAX_WALL_MS,
      memoryMb: this.config.CODEMODE_MEMORY_MB,
      ...hooks
    });
  }
}
