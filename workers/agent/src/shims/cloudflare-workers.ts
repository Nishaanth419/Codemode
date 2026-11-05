/**
 * Node.js stand-in for the `cloudflare:workers` built-in module.
 *
 * `@cloudflare/codemode` is published for the Workers runtime and its main entry
 * imports `DurableObject`, `RpcTarget` and `WorkerEntrypoint` from `cloudflare:workers`.
 * AgentOS runs on Node.js and only uses the runtime-neutral parts of the package
 * (`generateTypesFromJsonSchema`, `normalizeCode`, `sanitizeToolName`, `runCode`,
 * `resolveProvider`, `truncateResult`, and the `Executor` contract). These empty base
 * classes let that entry load. Anything that truly needs Workers (DynamicWorkerExecutor,
 * CodemodeRuntime Durable Objects) is never constructed in AgentOS.
 */
export class RpcTarget {}
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx?: unknown,
    public env?: Env
  ) {}
}
export class DurableObject<Env = unknown> {
  constructor(
    public ctx?: unknown,
    public env?: Env
  ) {}
}
export const env = {};
