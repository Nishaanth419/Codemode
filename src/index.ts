import express from "express";
import { Firestore } from "@google-cloud/firestore";
import { runAgent, type Env } from "./agent";
import { fetchMcpSession, mcpToolsToGenerated } from "./mcp-to-ts";

interface OAuthSession {
  state?: string;
  verifier?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

const MCP_RESOURCE = "https://mcp.indmoney.com/mcp";
const MCP_RESOURCE_METADATA = "https://mcp.indmoney.com/.well-known/oauth-protected-resource/mcp";
const SESSION_COOKIE = "indmoney_session";
const SESSION_COLLECTION = "indmoney_sessions";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const firestore = new Firestore();
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use("/api", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});

const env: Env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  MCP_SERVER_URL: process.env.MCP_SERVER_URL ?? MCP_RESOURCE,
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function sessionIdFromRequest(request: express.Request): string | null {
  return parseCookie(request.headers.cookie, SESSION_COOKIE);
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  const pair = cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

async function getSessionStore(sessionId: string): Promise<OAuthSession> {
  const ref = firestore.collection(SESSION_COLLECTION).doc(sessionId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return {};
  const stored = snapshot.data() as (OAuthSession & { updatedAt?: number }) | undefined;
  if (stored?.updatedAt && Date.now() - stored.updatedAt > SESSION_MAX_AGE_MS) {
    await ref.delete();
    return {};
  }
  return stored ?? {};
}

async function saveSessionStore(sessionId: string, session: OAuthSession): Promise<void> {
  await firestore.collection(SESSION_COLLECTION).doc(sessionId).set({
    ...session,
    updatedAt: Date.now(),
    sessionExpiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
  });
}

async function deleteSessionStore(sessionId: string): Promise<void> {
  await firestore.collection(SESSION_COLLECTION).doc(sessionId).delete();
}

function publicOrigin(request: express.Request): string {
  const configured = process.env.APP_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return `${request.protocol}://${request.get("host")}`;
}

function setSessionCookie(request: express.Request, response: express.Response, sessionId: string): void {
  response.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: request.secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

async function accessTokenForRequest(request: express.Request): Promise<string | null> {
  const sessionId = sessionIdFromRequest(request);
  if (!sessionId) return null;
  const session = await getSessionStore(sessionId);
  if (session.accessToken && (session.expiresAt ?? 0) > Date.now() + 30_000) return session.accessToken;
  if (!session.refreshToken || !session.clientId || !session.clientSecret) return null;

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    client_secret: session.clientSecret,
    resource: MCP_RESOURCE,
  });
  const response = await fetch("https://mcp.indmoney.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) return null;
  const token = await response.json<{ access_token: string; refresh_token?: string; expires_in?: number }>();
  session.accessToken = token.access_token;
  session.refreshToken = token.refresh_token ?? session.refreshToken;
  session.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
  await saveSessionStore(sessionId, session);
  return session.accessToken;
}

async function connectToIndMoney(request: express.Request, response: express.Response): Promise<void> {
  const redirectUri = `${publicOrigin(request)}/auth/indmoney/callback`;
  const sessionId = randomToken();
  const state = randomToken();
  const verifier = randomToken();
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

  const resourceResponse = await fetch(MCP_RESOURCE_METADATA);
  if (!resourceResponse.ok) throw new Error(`INDmoney resource metadata failed: HTTP ${resourceResponse.status}`);
  const resourceMetadata = await resourceResponse.json<{ authorization_servers?: string[] }>();
  if (!resourceMetadata.authorization_servers?.length) throw new Error("INDmoney did not advertise an OAuth authorization server");
  const authorizationServer = resourceMetadata.authorization_servers[0];
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", authorizationServer).toString();
  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) throw new Error(`INDmoney OAuth metadata failed: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json<{
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  }>();

  const registrationResponse = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Code Mode Agent",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  if (!registrationResponse.ok) {
    throw new Error(`INDmoney OAuth client registration failed: HTTP ${registrationResponse.status} ${(await registrationResponse.text()).slice(0, 300)}`);
  }
  const client = await registrationResponse.json<{ client_id: string; client_secret?: string }>();
  if (!client.client_id || !client.client_secret) throw new Error("INDmoney registration did not return the required client credentials");

  await saveSessionStore(sessionId, {
    state, verifier, clientId: client.client_id, clientSecret: client.client_secret, redirectUri,
  });

  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
    scope: "portfolio:read market:read",
  }).toString();
  setSessionCookie(request, response, sessionId);
  response.setHeader("Cache-Control", "no-store");
  response.redirect(302, authorize.toString());
}

async function finishIndMoneyLogin(request: express.Request, response: express.Response): Promise<void> {
  const error = request.query.error_description ?? request.query.error;
  if (error) {
    response.status(400).type("text/plain").send(`INDmoney sign-in was not completed: ${String(error)}`);
    return;
  }
  const sessionId = sessionIdFromRequest(request);
  const session = sessionId ? await getSessionStore(sessionId) : {};
  const code = request.query.code;
  if (!sessionId || !session.state || !session.verifier || !session.clientId || !session.clientSecret ||
      typeof code !== "string" || request.query.state !== session.state) {
    response.status(400).type("text/plain").send("INDmoney sign-in could not be verified. Please connect again.");
    return;
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: session.redirectUri ?? `${publicOrigin(request)}/auth/indmoney/callback`,
    client_id: session.clientId,
    client_secret: session.clientSecret,
    code_verifier: session.verifier,
    resource: MCP_RESOURCE,
  });
  const tokenResponse = await fetch("https://mcp.indmoney.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!tokenResponse.ok) {
    response.status(502).type("text/plain").send(`INDmoney token exchange failed: HTTP ${tokenResponse.status} ${(await tokenResponse.text()).slice(0, 500)}`);
    return;
  }
  const token = await tokenResponse.json<{ access_token: string; refresh_token?: string; expires_in?: number }>();
  session.accessToken = token.access_token;
  session.refreshToken = token.refresh_token;
  session.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
  delete session.state;
  delete session.verifier;
  await saveSessionStore(sessionId, session);
  response.setHeader("Cache-Control", "no-store");
  response.redirect(302, `${publicOrigin(request)}/`);
}

app.get("/healthz", (_request, response) => response.json({ ok: true }));
app.get("/auth/indmoney/connect", async (request, response, next) => {
  try { await connectToIndMoney(request, response); } catch (error) { next(error); }
});
app.get("/auth/indmoney/callback", async (request, response, next) => {
  try { await finishIndMoneyLogin(request, response); } catch (error) { next(error); }
});
app.post("/auth/indmoney/disconnect", async (request, response, next) => {
  try {
    const sessionId = sessionIdFromRequest(request);
    if (sessionId) {
      const session = await getSessionStore(sessionId);
      if (session.accessToken && session.clientId && session.clientSecret) {
        const revokeForm = new URLSearchParams({
          token: session.accessToken,
          token_type_hint: "access_token",
          client_id: session.clientId,
          client_secret: session.clientSecret,
        });
        await fetch("https://mcp.indmoney.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: revokeForm,
        }).catch((error) => console.error("INDmoney token revocation failed:", error));
      }
      await deleteSessionStore(sessionId);
    }
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: request.secure, sameSite: "lax", path: "/" });
    response.json({ connected: false });
  } catch (error) { next(error); }
});

app.get("/api/tools", async (request, response, next) => {
  try {
    const accessToken = await accessTokenForRequest(request);
    if (!accessToken) {
      response.json({ mcpServer: env.MCP_SERVER_URL, connected: false, toolCount: 0, tools: [], loginUrl: "/auth/indmoney/connect" });
      return;
    }
    const mcpSession = await fetchMcpSession(env.MCP_SERVER_URL, accessToken);
    const generated = mcpToolsToGenerated(mcpSession.tools);
    response.json({
      mcpServer: env.MCP_SERVER_URL,
      connected: true,
      toolCount: generated.length,
      tools: generated.map((item) => ({ name: item.name, description: item.description, tsSignature: item.tsSignature })),
    });
  } catch (error) { next(error); }
});

app.post("/api/chat", async (request, response, next) => {
  try {
    const message = request.body?.message;
    if (typeof message !== "string" || !message.trim()) {
      response.status(400).json({ error: "Missing 'message' field in request body" });
      return;
    }
    if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === "sk-your-key-here") {
      response.status(500).json({ error: "OPENAI_API_KEY not configured" });
      return;
    }
    const accessToken = await accessTokenForRequest(request);
    if (!accessToken) {
      response.status(401).json({ error: "Connect your INDmoney account before chatting.", loginUrl: "/auth/indmoney/connect" });
      return;
    }
    const agentResponse = await runAgent(message, env, accessToken);
    response.status(agentResponse.status).type(agentResponse.headers.get("content-type") ?? "text/plain");
    response.send(await agentResponse.text());
  } catch (error) { next(error); }
});

app.use(express.static(new URL("./public", import.meta.url).pathname, { extensions: ["html"] }));
app.use((_request, response) => response.status(404).json({ error: "Not found" }));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled server error:", error);
  response.status(500).json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) });
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => console.log(`Code Mode Agent listening on ${port}`));
