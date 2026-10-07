/**
 * sandbox-worker.ts — Dynamic Worker Sandbox Types and Utilities
 *
 * Re-exports the types we care about from @cloudflare/codemode so the rest
 * of the codebase has a single import point. The actual executor is created
 * in agent.ts where the LOADER binding is available.
 *
 * Security model:
 * - The sandbox receives NO direct network access (globalOutbound: null)
 * - It receives a `codemode` proxy that dispatches calls back to agent.ts
 *   via Workers RPC — API keys and MCP credentials never enter the sandbox
 * - Each invocation spins up a fresh V8 isolate (no state leaks)
 * - Execution is capped at 30 seconds
 */

export type { DynamicWorkerExecutor } from "@cloudflare/codemode";
