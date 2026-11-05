import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());

const providerName = z.enum(["groq", "gemini", "ollama"]);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: int(8787),
  HOST: z.string().default("127.0.0.1"),

  GROQ_API_KEY: optionalString,
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),

  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default("gemini-3.6-flash"),

  OLLAMA_ENABLED: bool(false),
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434/v1"),
  OLLAMA_MODEL: z.string().default("gpt-oss:20b"),

  LLM_PRIMARY_PROVIDER: providerName.default("groq"),
  LLM_FALLBACK_PROVIDER: z
    .string()
    .default("gemini")
    .transform((v) => (v.trim() === "" || v.trim() === "none" ? undefined : v.trim()))
    .pipe(providerName.optional()),
  LLM_AUTO_FAILOVER: bool(true),
  LLM_REQUEST_TIMEOUT_MS: int(60_000),
  LLM_MAX_RETRIES: int(2),
  LLM_MAX_RETRY_WAIT_MS: int(8_000),
  LLM_MAX_AGENT_STEPS: int(8),

  CODEMODE_EXECUTOR: z.enum(["local", "docker"]).default("local"),
  // Program run time; time spent waiting on host tools (installs, sandbox runs) is not counted.
  CODEMODE_TIMEOUT_MS: int(30_000),
  // Hard cap on an execution's total wall time, host tools included.
  CODEMODE_MAX_WALL_MS: int(300_000),
  CODEMODE_MEMORY_MB: int(128),

  SANDBOX_IMAGE: z.string().default("agentos-sandbox:latest"),
  SANDBOX_TIMEOUT_MS: int(20_000),
  SANDBOX_MEMORY_MB: int(256),
  SANDBOX_CPUS: z.string().default("0.5"),
  SANDBOX_PIDS_LIMIT: int(64),
  SANDBOX_ALLOWED_PACKAGES: z
    .string()
    .default(
      "pip:requests,pip:numpy,pip:pandas,pip:matplotlib,pip:pyyaml,pip:beautifulsoup4,pip:python-dateutil,npm:lodash,npm:dayjs,npm:zod,npm:csv-parse,npm:yaml,npm:marked"
    ),

  DATA_DIR: z.string().default(path.join(REPO_ROOT, ".data")),
  /** Host path of DATA_DIR, needed when the agent itself runs inside Docker and starts sibling sandbox containers. */
  WORKSPACE_HOST_DIR: optionalString,
  CODEMODE_RUNTIME_PATH: z.string().default(path.join(REPO_ROOT, "sandbox", "codemode-runtime.mjs")),
  CORS_ORIGIN: z.string().default("http://localhost:5173")
});

export type AppConfig = z.infer<typeof EnvSchema>;
export type ProviderName = z.infer<typeof providerName>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
