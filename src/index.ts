/**
 * index.ts — Worker Entrypoint
 *
 * Routes incoming HTTP requests:
 * - GET  /             → Serves the chat frontend (src/public/index.html)
 * - POST /api/chat     → Run the Code Mode agent with a user message (streaming)
 * - GET  /api/tools    → List available MCP tools and generated TypeScript declarations
 *
 * This Worker holds MCP credentials. API keys never enter generated code —
 * all MCP calls from the Dynamic Worker sandbox route back through here via RPC.
 */

// Wrangler inlines static assets referenced with the `Text` module type.
// See wrangler.toml [rules] section.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- HTML module type is resolved by wrangler at bundle time
import FRONTEND_HTML from "./public/index.html";
// @ts-ignore -- PWA files are served as text modules by Wrangler.
import WEB_MANIFEST from "./public/manifest.webmanifest";
// @ts-ignore -- PWA files are served as text modules by Wrangler.
import SERVICE_WORKER from "./public/sw.js";
// @ts-ignore -- PWA files are served as text modules by Wrangler.
import APP_ICON from "./public/icon.svg";


import { runAgent, type Env } from "./agent";
import { fetchMcpSession, mcpToolsToGenerated, generateApiDeclaration } from "./mcp-to-ts";
import { DurableObject } from "cloudflare:workers";

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

/** Durable, per-browser storage for the OAuth flow and INDmoney tokens. */
export class AuthSessionStore extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json((await this.ctx.storage.get<OAuthSession>("session")) ?? {});
    }
    if (request.method === "PUT") {
      await this.ctx.storage.put("session", await request.json<OAuthSession>());
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      await this.ctx.storage.delete("session");
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", { status: 405 });
  }
}

const MCP_RESOURCE = "https://mcp.indmoney.com/mcp";
const MCP_RESOURCE_METADATA = "https://mcp.indmoney.com/.well-known/oauth-protected-resource/mcp";
const SESSION_COOKIE = "indmoney_session";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function getSessionStore(env: Env, sessionId: string): Promise<OAuthSession> {
  const id = env.AUTH_SESSIONS.idFromName(sessionId);
  const response = await env.AUTH_SESSIONS.get(id).fetch("https://session.internal/", { method: "GET" });
  return await response.json<OAuthSession>();
}

async function saveSessionStore(env: Env, sessionId: string, session: OAuthSession): Promise<void> {
  const id = env.AUTH_SESSIONS.idFromName(sessionId);
  await env.AUTH_SESSIONS.get(id).fetch("https://session.internal/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session),
  });
}

function sessionIdFromRequest(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1) ?? null;
}

function sessionCookie(id: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

async function accessTokenForRequest(request: Request, env: Env): Promise<string | null> {
  const sessionId = sessionIdFromRequest(request);
  if (!sessionId) return null;
  const session = await getSessionStore(env, sessionId);
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
  await saveSessionStore(env, sessionId, session);
  return session.accessToken;
}

async function connectToIndMoney(request: Request, env: Env): Promise<Response> {
  const redirectUri = new URL("/auth/indmoney/callback", request.url).toString();
  const sessionId = randomToken();
  const state = randomToken();
  const verifier = randomToken();
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

  // INDmoney advertises OAuth Authorization Code + PKCE and a registration endpoint.
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

  await saveSessionStore(env, sessionId, {
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
  return new Response(null, {
    status: 302,
    headers: { Location: authorize.toString(), "Set-Cookie": sessionCookie(sessionId, request), "Cache-Control": "no-store" },
  });
}

async function finishIndMoneyLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error) return new Response(`INDmoney sign-in was not completed: ${error}`, { status: 400 });
  const sessionId = sessionIdFromRequest(request);
  const session = sessionId ? await getSessionStore(env, sessionId) : {};
  const code = url.searchParams.get("code");
  if (!sessionId || !session.state || !session.verifier || !session.clientId || !session.clientSecret ||
      !code || url.searchParams.get("state") !== session.state) {
    return new Response("INDmoney sign-in could not be verified. Please connect again.", { status: 400 });
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: session.redirectUri ?? new URL("/auth/indmoney/callback", request.url).toString(),
    client_id: session.clientId,
    client_secret: session.clientSecret,
    code_verifier: session.verifier,
    resource: MCP_RESOURCE,
  });
  const response = await fetch("https://mcp.indmoney.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) return new Response(`INDmoney token exchange failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`, { status: 502 });
  const token = await response.json<{ access_token: string; refresh_token?: string; expires_in?: number }>();
  session.accessToken = token.access_token;
  session.refreshToken = token.refresh_token;
  session.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
  delete session.state;
  delete session.verifier;
  await saveSessionStore(env, sessionId, session);
  return new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── CORS headers for frontend consumption ────────────────────────
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (request.method === "GET" && url.pathname === "/manifest.webmanifest") {
        return new Response(WEB_MANIFEST as string, {
          headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" },
        });
      }
      if (request.method === "GET" && url.pathname === "/sw.js") {
        return new Response(SERVICE_WORKER as string, {
          headers: { "Content-Type": "application/javascript; charset=UTF-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" },
        });
      }
      if (request.method === "GET" && url.pathname === "/icon.svg") {
        return new Response(APP_ICON as string, {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
        });
      }

      if (url.pathname === "/auth/indmoney/connect" && request.method === "GET") {
        return await connectToIndMoney(request, env);
      }
      if (url.pathname === "/auth/indmoney/callback" && request.method === "GET") {
        return await finishIndMoneyLogin(request, env);
      }
      if (url.pathname === "/auth/indmoney/disconnect" && request.method === "POST") {
        const sessionId = sessionIdFromRequest(request);
        if (sessionId) {
          const session = await getSessionStore(env, sessionId);
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
          const id = env.AUTH_SESSIONS.idFromName(sessionId);
          await env.AUTH_SESSIONS.get(id).fetch("https://session.internal/", { method: "DELETE" });
        }
        return new Response(JSON.stringify({ connected: false }), {
          headers: { "Content-Type": "application/json", "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
        });
      }

      switch (url.pathname) {
        // ── POST /api/chat — Main agent endpoint ───────────────────
        case "/api/chat": {
          if (request.method !== "POST") {
            return jsonResponse(
              { error: "Method not allowed. Use POST." },
              405,
              corsHeaders
            );
          }

          const body = await request.json<{ message?: string }>();
          const userMessage = body?.message;

          if (!userMessage || typeof userMessage !== "string") {
            return jsonResponse(
              { error: "Missing 'message' field in request body" },
              400,
              corsHeaders
            );
          }

          if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === "sk-your-key-here") {
            return jsonResponse(
              {
                error: "OPENAI_API_KEY not configured",
                hint: "Set it in .dev.vars for local dev, or via `wrangler secret put OPENAI_API_KEY` for production",
              },
              500,
              corsHeaders
            );
          }

          const accessToken = await accessTokenForRequest(request, env);
          if (!accessToken) {
            return jsonResponse({
              error: "Connect your INDmoney account before chatting.",
              loginUrl: "/auth/indmoney/connect",
            }, 401, corsHeaders);
          }

          // Run the agent and return the streaming response
          const response = await runAgent(userMessage, env, accessToken);

          // Add CORS headers to the streaming response
          const headers = new Headers(response.headers);
          for (const [key, value] of Object.entries(corsHeaders)) {
            headers.set(key, value);
          }

          return new Response(response.body, {
            status: response.status,
            headers,
          });
        }

        // ── GET /api/tools — Debug endpoint to inspect MCP tools ───
        case "/api/tools": {
          if (request.method !== "GET") {
            return jsonResponse(
              { error: "Method not allowed. Use GET." },
              405,
              corsHeaders
            );
          }

          const accessToken = await accessTokenForRequest(request, env);
          if (!accessToken) {
            return jsonResponse({
              mcpServer: env.MCP_SERVER_URL,
              connected: false,
              toolCount: 0,
              tools: [],
              loginUrl: "/auth/indmoney/connect",
            }, 200, corsHeaders);
          }

          const mcpSession = await fetchMcpSession(env.MCP_SERVER_URL, accessToken);
          const generated = mcpToolsToGenerated(mcpSession.tools);
          const apiDeclaration = generateApiDeclaration(generated);

          return jsonResponse(
            {
              mcpServer: env.MCP_SERVER_URL,
              connected: true,
              toolCount: generated.length,
              tools: generated.map((t) => ({
                name: t.name,
                description: t.description,
                tsSignature: t.tsSignature,
              })),
              apiDeclaration,
            },
            200,
            corsHeaders
          );
        }

        // ── GET / — Serve the chat frontend ───────────────────────
        case "/": {
          if (request.method !== "GET") {
            return jsonResponse({ error: "Method not allowed. Use GET." }, 405, corsHeaders);
          }
          return new Response(FRONTEND_HTML as string, {
            headers: { 
              "Content-Type": "text/html;charset=UTF-8",
              "Cache-Control": "no-cache, no-store, must-revalidate"
            },
          });
        }

        default:
          return jsonResponse({ error: "Not found" }, 404, corsHeaders);
      }
    } catch (error) {
      console.error("Unhandled error:", error);
      return jsonResponse(
        {
          error: "Internal server error",
          details: error instanceof Error ? error.message : String(error),
        },
        500,
        corsHeaders
      );
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Helper to build a JSON response with consistent headers.
 */
function jsonResponse(
  data: unknown,
  status: number,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
