/**
 * Provider-independent LLM contract.
 *
 * Every provider (Groq, Gemini, Ollama) translates these internal shapes to its own
 * wire format and back. The agent loop, the router and the persistence layer only
 * ever see these types, so a conversation can move between providers mid-run.
 */
import type { ZodType } from "zod";
import type { ProviderError } from "./errors.js";

export type ProviderName = "groq" | "gemini" | "ollama";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  groq: "Groq",
  gemini: "Gemini",
  ollama: "Ollama"
};

/** JSON Schema object used for tool parameters and structured output. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** Normalized tool call. Provider-specific data lives in `providerMeta`. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  providerMeta?: {
    provider: ProviderName;
    /** Gemini thought signature; must be replayed verbatim to Gemini, ignored elsewhere. */
    thoughtSignature?: string;
  };
}

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      provider?: ProviderName;
      model?: string;
    }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface GenerateRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "unknown";

export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage?: TokenUsage;
  provider: ProviderName;
  model: string;
  latencyMs: number;
}

export type StreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "finish"; result: GenerateResult };

export interface StructuredRequest<T> extends Omit<GenerateRequest, "tools" | "toolChoice"> {
  schema: ZodType<T>;
  /** JSON Schema equivalent of `schema`, sent to the provider. */
  jsonSchema: JsonSchema;
  schemaName: string;
}

export interface StructuredResult<T> {
  object: T;
  result: GenerateResult;
}

export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** True when the provider has the credentials / endpoint it needs. */
  isConfigured(): boolean;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /**
   * Streams text deltas, then exactly one `finish` chunk carrying the full result
   * (including tool calls). Tool calls are only surfaced in the final result so a
   * partially streamed tool call can never be executed.
   */
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
  /** Convert any thrown value into a classified ProviderError. */
  normalizeError(error: unknown): ProviderError;
}

export function newToolCallId(prefix = "call"): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Parse tool-call arguments delivered as a JSON string; never throws. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { __raw: raw };
  }
}

/** Extract a JSON object from model text (handles ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error("Model output did not contain valid JSON");
  }
}
