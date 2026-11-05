import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./src/shims/cloudflare-workers.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    testTimeout: 20_000,
    server: { deps: { inline: ["@cloudflare/codemode"] } }
  }
});
