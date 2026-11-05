/**
 * Registers a module resolution hook that maps `cloudflare:workers` to the local shim.
 * Loaded with `node --import` / `tsx --import` before the app starts.
 */
import { registerHooks } from "node:module";

const shimUrl = new URL("./cloudflare-workers.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: shimUrl, shortCircuit: true, format: "module" };
    }
    return nextResolve(specifier, context);
  }
});
