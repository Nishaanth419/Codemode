/**
 * HTTP API + Server-Sent Events. API keys never leave the server: the frontend
 * only ever sees provider names, models and health status.
 */
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "./app.js";
import { rowToEvent, type AgentEvent } from "./agent/event-bus.js";
import { namespaceTypes } from "./codemode/code-tool.js";
import type { ExecutionRow } from "./db/database.js";

const SendMessage = z.object({ content: z.string().trim().min(1).max(20_000) });
const CreateSession = z.object({ title: z.string().trim().max(120).optional() });

export function createServer(ctx: AppContext) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin === ctx.config.CORS_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const status = () => ({
    llm: {
      ...ctx.router.health.snapshot(),
      primary: ctx.config.LLM_PRIMARY_PROVIDER,
      fallback: ctx.config.LLM_FALLBACK_PROVIDER ?? null,
      quotaNote: "Remaining quota is not reported by Groq or Gemini free-tier APIs, so it is not shown."
    },
    executor: ctx.executionRouter.info,
    sandbox: ctx.sandboxStatus()
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/status", (_req, res) => res.json(status()));
  app.get("/api/providers/status", (_req, res) => res.json(ctx.router.health.snapshot()));

  app.get("/api/tools", (_req, res) => {
    res.json({
      namespaces: ctx.namespaces.map((ns) => ({
        name: ns.name,
        description: ns.description,
        types: namespaceTypes(ns),
        tools: Object.entries(ns.tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }))
      })),
      allowedPackages: ctx.packages.allowlist()
    });
  });

  // ------------------------------------------------------------ sessions

  app.get("/api/sessions", (_req, res) => res.json({ sessions: ctx.db.listSessions() }));

  app.post("/api/sessions", (req, res) => {
    const body = CreateSession.parse(req.body ?? {});
    const id = `ses_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    res.status(201).json(ctx.db.createSession(id, body.title || "New session"));
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = ctx.db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json({
      session,
      messages: ctx.db.listMessages(session.id),
      runs: ctx.db.listRuns(session.id).map((r) => ({ ...r, error: r.error ? JSON.parse(r.error) : null })),
      executions: ctx.db.listExecutions(session.id).map(executionDto),
      busy: ctx.runner.isBusy(session.id)
    });
  });

  app.delete("/api/sessions/:id", (req, res) => {
    if (ctx.runner.isBusy(req.params.id)) return res.status(409).json({ error: "Session has a run in progress" });
    ctx.db.deleteSession(req.params.id);
    res.status(204).end();
  });

  app.post("/api/sessions/:id/messages", (req, res) => {
    const { content } = SendMessage.parse(req.body);
    const sessionId = req.params.id;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) return res.status(400).json({ error: "Invalid session id" });
    if (ctx.runner.isBusy(sessionId)) return res.status(409).json({ error: "A run is already in progress for this session" });
    const { runId } = ctx.runner.start(sessionId, content);
    res.status(202).json({ runId, sessionId });
  });

  app.post("/api/runs/:id/cancel", (req, res) => {
    res.json({ cancelled: ctx.runner.cancel(req.params.id) });
  });

  // ------------------------------------------------------------ events (SSE)

  app.get("/api/sessions/:id/events", (req, res) => {
    const sessionId = req.params.id;
    const lastId = Number(req.header("last-event-id") ?? req.query.after ?? 0) || 0;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const write = (e: AgentEvent) => {
      if (e.id !== null) res.write(`id: ${e.id}\n`);
      res.write(`event: agent\ndata: ${JSON.stringify(e)}\n\n`);
    };
    for (const row of ctx.db.listEvents({ sessionId, afterId: lastId })) write(rowToEvent(row));
    const unsubscribe = ctx.bus.subscribe(sessionId, write);
    const sendStatus = () => res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    sendStatus();
    let pending: NodeJS.Timeout | undefined;
    const onHealth = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        sendStatus();
      }, 150);
    };
    ctx.router.health.on("change", onHealth);
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15_000);
    req.on("close", () => {
      unsubscribe();
      ctx.router.health.off("change", onHealth);
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
    });
  });

  // ------------------------------------------------------------ executions

  app.get("/api/executions", (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    res.json({ executions: ctx.db.listExecutions(sessionId).map(executionDto) });
  });

  app.get("/api/executions/:id", (req, res) => {
    const row = ctx.db.getExecution(req.params.id);
    if (!row) return res.status(404).json({ error: "Execution not found" });
    res.json(executionDto(row));
  });

  // ------------------------------------------------------------ files / artifacts

  app.get("/api/sessions/:id/files", async (req, res, next) => {
    try {
      res.json({ files: await ctx.workspace.list(req.params.id) });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/sessions/:id/files/content", async (req, res, next) => {
    try {
      res.json(await ctx.workspace.read(req.params.id, String(req.query.path ?? "")));
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/sessions/:id/files/download", (req, res, next) => {
    try {
      const rel = String(req.query.path ?? "");
      const { file, stream } = ctx.workspace.stream(req.params.id, rel);
      res.setHeader("content-disposition", `attachment; filename="${path.basename(file).replace(/"/g, "")}"`);
      res.setHeader("content-type", "application/octet-stream");
      stream.on("error", (e) => next(e));
      stream.pipe(res);
    } catch (e) {
      next(e);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", issues: err.issues });
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : /outside the workspace|Invalid/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  });

  return app;
}

function executionDto(row: ExecutionRow) {
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    code: row.code,
    provider: row.provider,
    model: row.model,
    executor: row.executor,
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    logs: row.logs ? JSON.parse(row.logs) : [],
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : [],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms
  };
}
