import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { REPO_ROOT, loadConfig } from "./config.js";
import { createAppContext } from "./app.js";
import { createServer } from "./server.js";
import { PROVIDER_LABELS } from "./providers/index.js";

loadDotenv({ path: path.join(REPO_ROOT, ".env"), quiet: true });
loadDotenv({ quiet: true });

const config = loadConfig();
const ctx = createAppContext(config);
const app = createServer(ctx);

const server = app.listen(config.PORT, config.HOST, () => {
  const snap = ctx.router.health.snapshot();
  const chain = snap.providers
    .map((p) => `${PROVIDER_LABELS[p.name]} (${p.model}) ${p.configured ? p.role : "not configured"}`)
    .join(" → ");
  const sbx = ctx.sandboxStatus();
  console.log(`AgentOS agent listening on http://${config.HOST}:${config.PORT}`);
  console.log(`  LLM chain: ${chain}${config.LLM_AUTO_FAILOVER ? "" : " (auto-failover OFF)"}`);
  console.log(`  Code Mode executor: ${ctx.executionRouter.info.label}`);
  console.log(
    `  Docker sandbox: ${sbx.available ? `docker ${sbx.version}, image ${sbx.image} ${sbx.imagePresent ? "present" : "MISSING (run: npm run sandbox:build)"}` : `unavailable (${sbx.error})`}`
  );
  if (!ctx.router.chain().length) console.warn("  WARNING: no LLM provider configured. Set GROQ_API_KEY and/or GEMINI_API_KEY in .env");
  if (!ctx.mcp.size) console.log("  MCP servers: none (set MCP_CONFIG_FILE or MCP_SERVERS)");
});

// MCP servers connect in the background; a server that is down never blocks startup.
void ctx.mcp.start().then(() => {
  for (const s of ctx.mcp.status()) {
    const detail = s.state === "connected" ? `${s.toolCount} tools as \`${s.namespace}.*\`` : s.state === "disabled" ? "disabled" : `FAILED: ${s.error}`;
    console.log(`  MCP ${s.name} (${s.transport}: ${s.target}) → ${detail}`);
  }
});

const shutdown = () => {
  server.close();
  // Close MCP connections (stops stdio server processes), but never hang the shutdown on them.
  void Promise.race([ctx.mcp.close(), new Promise((r) => setTimeout(r, 3_000))]).finally(() => {
    ctx.db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
