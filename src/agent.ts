/**
 * Agent loop that exposes each INDmoney MCP tool directly to the model.
 * Tool schemas are discovered for each request and converted to AI SDK tools;
 * calls are proxied to MCP using the user's OAuth session.
 */

import { isStepCount, streamText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import {
  fetchMcpSession,
  mcpToolsToGenerated,
  type GeneratedTool,
} from "./mcp-to-ts";

/** Environment values configured on the Cloud Run service. */
export interface Env {
  OPENAI_API_KEY: string;
  MCP_SERVER_URL: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

type ToolDescriptors = Record<string, {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (args: unknown) => Promise<unknown>;
}>;

function buildToolDescriptors(
  generatedTools: GeneratedTool[],
  mcpServerUrl: string,
  sessionId: string | null,
  accessToken: string,
  protocolVersion: string,
  onToolError: (message: string) => void
): ToolDescriptors {
  const descriptors: ToolDescriptors = {};

  for (const generatedTool of generatedTools) {
    descriptors[generatedTool.name] = {
      description: generatedTool.description,
      inputSchema: generatedTool.parameters,
      execute: async (args: unknown) => {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${accessToken}`,
            "MCP-Protocol-Version": protocolVersion,
          };
          if (sessionId) headers["mcp-session-id"] = sessionId;

          const response = await fetch(mcpServerUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now(),
              method: "tools/call",
              params: { name: generatedTool.name, arguments: args },
            }),
          });

          if (!response.ok) {
            const responseBody = (await response.text()).slice(0, 500);
            throw new Error(
              `MCP tools/call failed for "${generatedTool.name}": ${response.status} ${response.statusText}` +
              (responseBody ? `. Response: ${responseBody}` : "")
            );
          }

          const contentType = response.headers.get("content-type") ?? "";
          let rpcResult: Record<string, unknown> | null = null;
          if (contentType.includes("text/event-stream")) {
            const text = await response.text();
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data && data !== "[DONE]") {
                rpcResult = JSON.parse(data) as Record<string, unknown>;
                break;
              }
            }
          } else {
            rpcResult = await response.json() as Record<string, unknown>;
          }

          const rpcError = rpcResult?.error as Record<string, unknown> | undefined;
          if (rpcError) {
            const message = typeof rpcError.message === "string" ? rpcError.message : JSON.stringify(rpcError);
            throw new Error(`MCP tools/call error for "${generatedTool.name}": ${message}`);
          }

          const toolResult = rpcResult?.result as Record<string, unknown> | undefined;
          if (toolResult?.isError === true) {
            const content = Array.isArray(toolResult.content)
              ? toolResult.content.map((block) => {
                const item = block as Record<string, unknown>;
                return item.text ?? JSON.stringify(item);
              }).join("\n")
              : JSON.stringify(toolResult);
            throw new Error(`MCP tool "${generatedTool.name}" failed: ${content}`);
          }

          // Return text blocks as readable text and preserve structured content
          // where the MCP server provides it.
          if (Array.isArray(toolResult?.content)) {
            return toolResult.content.map((block) => {
              const item = block as Record<string, unknown>;
              return item.text ?? JSON.stringify(item);
            }).join("\n");
          }
          return toolResult ?? rpcResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          onToolError(message);
          throw error;
        }
      },
    };
  }

  return descriptors;
}

function buildSystemPrompt(): string {
  return `You are a helpful assistant that answers questions using the available INDmoney MCP tools. Use earlier user and assistant messages as context, especially for follow-up questions.

Call the relevant tools directly when the user asks about their account. Use only the data returned by tools; never invent holdings, balances, transactions, or performance. If a tool fails, report its exact error and do not claim that data was retrieved or retry speculatively.

When tool results contain comparable numeric data (such as holdings, allocations, balances over time, or category totals), proactively include one chart in a \`chart\` fenced block using valid JSON, for example:
\`\`\`chart
{"type":"bar","title":"Current value by holding","unit":"₹","data":[{"label":"Fund A","value":125000}]}
\`\`\`
Use \`bar\` to compare categories and \`donut\` for a part-to-whole split. Include only relevant items (usually 5–10), explain the largest concentration in the surrounding text, and chart only values returned by the tools. If a tool fails or provides no numeric data, explain that clearly and do not fabricate a chart.`;
}

/** Run one chat turn and return the assistant's response as plain text. */
export async function runAgent(
  userMessage: string,
  env: Env,
  accessToken: string,
  history: ConversationMessage[] = []
): Promise<Response> {
  console.log(`Connecting to MCP server: ${env.MCP_SERVER_URL}`);

  let generatedTools: GeneratedTool[];
  let sessionId: string | null = null;
  let protocolVersion = "2025-03-26";
  try {
    const mcpSession = await fetchMcpSession(env.MCP_SERVER_URL, accessToken);
    sessionId = mcpSession.sessionId;
    protocolVersion = mcpSession.protocolVersion;
    generatedTools = mcpToolsToGenerated(mcpSession.tools);
    console.log(`Loaded ${generatedTools.length} tools from MCP server`);
  } catch (error) {
    console.error("Failed to connect to MCP server:", error);
    return new Response(JSON.stringify({
      error: "Failed to connect to MCP server",
      details: error instanceof Error ? error.message : String(error),
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const mcpToolErrors: string[] = [];
  const descriptors = buildToolDescriptors(
    generatedTools,
    env.MCP_SERVER_URL,
    sessionId,
    accessToken,
    protocolVersion,
    (message) => mcpToolErrors.push(message)
  );
  const modelTools = Object.fromEntries(Object.entries(descriptors).map(([name, descriptor]) => [name, tool({
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    execute: descriptor.execute,
  })]));

  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  const result = streamText({
    model: openai("gpt-4o"),
    system: buildSystemPrompt(),
    messages: [
      ...history.map(({ role, content }) => ({ role, content })),
      { role: "user" as const, content: userMessage },
    ],
    tools: modelTools,
    stopWhen: [isStepCount(5), () => mcpToolErrors.length > 0],
    onError: (error) => console.error("streamText error:", error),
  });

  let answer = "";
  try {
    answer = await result.text;
  } catch (error) {
    if (mcpToolErrors.length === 0) throw error;
  }
  if (mcpToolErrors.length > 0) {
    return new Response(JSON.stringify({
      error: "INDmoney data request failed",
      details: mcpToolErrors[0],
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  return new Response(answer, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
