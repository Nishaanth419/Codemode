"""FastAPI application for OAuth, private chat history, and INDmoney MCP."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from google.cloud import firestore
from pydantic import BaseModel

from .agent import run_agent
from .mcp_client import fetch_mcp_session

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("codemode")

MCP_RESOURCE = os.getenv("MCP_SERVER_URL", "https://mcp.indmoney.com/mcp")
MCP_RESOURCE_METADATA = "https://mcp.indmoney.com/.well-known/oauth-protected-resource/mcp"
SESSION_COOKIE = "indmoney_session"
SESSION_COLLECTION = "indmoney_sessions"
SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
MAX_HISTORY_MESSAGES = 20
MAX_HISTORY_MESSAGE_CHARS = 12_000
MAX_CHATS_PER_SESSION = 50
PUBLIC_DIR = Path(__file__).resolve().parent.parent / "src" / "public"

app = FastAPI(title="Code Mode Agent", docs_url=None, redoc_url=None)


class ChatRequest(BaseModel):
    message: str
    chatId: str


@lru_cache(maxsize=1)
def get_db() -> firestore.Client:
    """Create Firestore on demand so health/static routes work without local ADC."""
    return firestore.Client()


def random_token() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")


def session_id(request: Request) -> str | None:
    return request.cookies.get(SESSION_COOKIE)


def session_ref(sid: str):
    return get_db().collection(SESSION_COLLECTION).document(sid)


def chat_collection(sid: str):
    return session_ref(sid).collection("chats")


def get_session(sid: str) -> dict[str, Any]:
    ref = session_ref(sid)
    snapshot = ref.get()
    if not snapshot.exists:
        return {}
    stored = snapshot.to_dict() or {}
    updated = stored.get("updatedAt", 0)
    if updated and time.time() * 1000 - updated > SESSION_MAX_AGE_SECONDS * 1000:
        ref.delete()
        return {}
    return stored


def save_session(sid: str, values: dict[str, Any]) -> None:
    values = dict(values)
    values["updatedAt"] = int(time.time() * 1000)
    values["sessionExpiresAt"] = datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
    session_ref(sid).set(values)


def request_origin(request: Request) -> str:
    configured = os.getenv("APP_ORIGIN", "").strip().rstrip("/")
    if configured:
        return configured
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", "localhost"))
    return f"{proto}://{host}"


def is_secure_request(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"


def cookie_options(request: Request) -> dict[str, Any]:
    return {"key": SESSION_COOKIE, "httponly": True, "secure": is_secure_request(request), "samesite": "lax", "path": "/", "max_age": SESSION_MAX_AGE_SECONDS}


async def access_token(request: Request) -> tuple[str | None, str | None]:
    sid = session_id(request)
    if not sid:
        return None, None
    stored = get_session(sid)
    token = stored.get("accessToken")
    if token and stored.get("expiresAt", 0) > time.time() * 1000 + 30_000:
        return sid, token
    if not stored.get("refreshToken") or not stored.get("clientId") or not stored.get("clientSecret"):
        return sid, None
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post("https://mcp.indmoney.com/token", data={
            "grant_type": "refresh_token", "refresh_token": stored["refreshToken"],
            "client_id": stored["clientId"], "client_secret": stored["clientSecret"], "resource": MCP_RESOURCE,
        })
    if not response.is_success:
        logger.warning("INDmoney token refresh failed: HTTP %s", response.status_code)
        return sid, None
    result = response.json()
    stored["accessToken"] = result["access_token"]
    stored["refreshToken"] = result.get("refresh_token", stored["refreshToken"])
    stored["expiresAt"] = int(time.time() * 1000) + int(result.get("expires_in", 3600)) * 1000
    save_session(sid, stored)
    return sid, stored["accessToken"]


def auth_error(message: str) -> JSONResponse:
    return JSONResponse({"error": message, "loginUrl": "/auth/indmoney/connect"}, status_code=401, headers={"Cache-Control": "no-store"})


@app.middleware("http")
async def no_store_api(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/auth/indmoney/connect")
async def connect_indmoney(request: Request):
    redirect_uri = f"{request_origin(request)}/auth/indmoney/callback"
    sid, state, verifier = random_token(), random_token(), random_token()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    async with httpx.AsyncClient(timeout=30) as client:
        resource_response = await client.get(MCP_RESOURCE_METADATA)
        resource_response.raise_for_status()
        resource_meta = resource_response.json()
        servers = resource_meta.get("authorization_servers", [])
        if not servers:
            raise HTTPException(502, "INDmoney did not advertise an OAuth authorization server")
        metadata_response = await client.get(f"{servers[0].rstrip('/')}/.well-known/oauth-authorization-server")
        metadata_response.raise_for_status()
        metadata = metadata_response.json()
        registration = await client.post(metadata["registration_endpoint"], json={
            "client_name": "Code Mode Agent", "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
            "token_endpoint_auth_method": "client_secret_post",
        })
        if not registration.is_success:
            raise HTTPException(502, f"INDmoney OAuth client registration failed: HTTP {registration.status_code} {registration.text[:300]}")
        client_info = registration.json()
    if not client_info.get("client_id") or not client_info.get("client_secret"):
        raise HTTPException(502, "INDmoney registration did not return the required client credentials")
    save_session(sid, {"state": state, "verifier": verifier, "clientId": client_info["client_id"], "clientSecret": client_info["client_secret"], "redirectUri": redirect_uri})
    authorize = metadata["authorization_endpoint"] + "?" + urlencode({
        "response_type": "code", "client_id": client_info["client_id"], "redirect_uri": redirect_uri,
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        "resource": MCP_RESOURCE, "scope": "portfolio:read market:read",
    })
    response = RedirectResponse(authorize, status_code=302, headers={"Cache-Control": "no-store"})
    response.set_cookie(value=sid, **cookie_options(request))
    return response


@app.get("/auth/indmoney/callback")
async def finish_indmoney_login(request: Request):
    error = request.query_params.get("error_description") or request.query_params.get("error")
    if error:
        return PlainTextResponse(f"INDmoney sign-in was not completed: {error}", status_code=400)
    sid = session_id(request)
    stored = get_session(sid) if sid else {}
    code = request.query_params.get("code")
    if not sid or not stored.get("state") or not stored.get("verifier") or not stored.get("clientId") or not stored.get("clientSecret") or not code or request.query_params.get("state") != stored.get("state"):
        return PlainTextResponse("INDmoney sign-in could not be verified. Please connect again.", status_code=400)
    async with httpx.AsyncClient(timeout=30) as client:
        token_response = await client.post("https://mcp.indmoney.com/token", data={
            "grant_type": "authorization_code", "code": code,
            "redirect_uri": stored.get("redirectUri", f"{request_origin(request)}/auth/indmoney/callback"),
            "client_id": stored["clientId"], "client_secret": stored["clientSecret"],
            "code_verifier": stored["verifier"], "resource": MCP_RESOURCE,
        })
    if not token_response.is_success:
        return PlainTextResponse(f"INDmoney token exchange failed: HTTP {token_response.status_code} {token_response.text[:500]}", status_code=502)
    token = token_response.json()
    stored.update({"accessToken": token["access_token"], "refreshToken": token.get("refresh_token"), "expiresAt": int(time.time() * 1000) + int(token.get("expires_in", 3600)) * 1000})
    stored.pop("state", None)
    stored.pop("verifier", None)
    save_session(sid, stored)
    return RedirectResponse(request_origin(request) + "/", status_code=302, headers={"Cache-Control": "no-store"})


@app.post("/auth/indmoney/disconnect")
async def disconnect_indmoney(request: Request):
    sid = session_id(request)
    if sid:
        stored = get_session(sid)
        if stored.get("accessToken") and stored.get("clientId") and stored.get("clientSecret"):
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    await client.post("https://mcp.indmoney.com/revoke", data={
                        "token": stored["accessToken"], "token_type_hint": "access_token",
                        "client_id": stored["clientId"], "client_secret": stored["clientSecret"],
                    })
            except Exception:
                logger.exception("INDmoney token revocation failed")
        chats = chat_collection(sid)
        while True:
            page = list(chats.limit(400).stream())
            if not page:
                break
            batch = get_db().batch()
            for document in page:
                batch.delete(document.reference)
            batch.commit()
        session_ref(sid).delete()
    response = JSONResponse({"connected": False})
    response.delete_cookie(SESSION_COOKIE, httponly=True, secure=is_secure_request(request), samesite="lax", path="/")
    return response


@app.get("/api/chats")
async def list_chats(request: Request):
    sid, token = await access_token(request)
    if not sid or not token:
        return auth_error("Sign in with INDmoney to access your private chat history.")
    docs = chat_collection(sid).order_by("updatedAt", direction=firestore.Query.DESCENDING).limit(MAX_CHATS_PER_SESSION).stream()
    return {"chats": [{"id": doc.id, "title": doc.get("title"), "updatedAt": doc.get("updatedAt")} for doc in docs]}


@app.post("/api/chats", status_code=201)
async def create_chat(request: Request):
    sid, token = await access_token(request)
    if not sid or not token:
        return auth_error("Sign in with INDmoney to create a private chat.")
    chats = chat_collection(sid)
    existing = list(chats.order_by("updatedAt", direction=firestore.Query.ASCENDING).limit(MAX_CHATS_PER_SESSION).stream())
    if len(existing) >= MAX_CHATS_PER_SESSION:
        existing[0].reference.delete()
    identifier = random_token()
    chat = {"title": "New chat", "messages": [], "updatedAt": int(time.time() * 1000), "sessionExpiresAt": datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE_SECONDS)}
    chats.document(identifier).create(chat)
    return {"id": identifier, **chat}


@app.get("/api/chats/{chat_id}")
async def get_chat(chat_id: str, request: Request):
    sid, token = await access_token(request)
    if not sid or not token:
        return auth_error("Sign in with INDmoney to access your chats.")
    snapshot = chat_collection(sid).document(chat_id).get()
    if not snapshot.exists:
        return JSONResponse({"error": "Chat not found."}, status_code=404)
    return {"id": snapshot.id, **(snapshot.to_dict() or {})}


@app.delete("/api/chats/{chat_id}")
async def delete_chat(chat_id: str, request: Request):
    sid, token = await access_token(request)
    if not sid or not token:
        return auth_error("Sign in with INDmoney to delete your chats.")
    ref = chat_collection(sid).document(chat_id)
    if not ref.get().exists:
        return JSONResponse({"error": "Chat not found."}, status_code=404)
    ref.delete()
    return {"deleted": True}


@app.get("/api/tools")
async def list_tools(request: Request):
    _, token = await access_token(request)
    if not token:
        return {"mcpServer": MCP_RESOURCE, "connected": False, "toolCount": 0, "tools": [], "loginUrl": "/auth/indmoney/connect"}
    try:
        session = await fetch_mcp_session(MCP_RESOURCE, token)
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc
    tools = session["tools"]
    return {"mcpServer": MCP_RESOURCE, "connected": True, "toolCount": len(tools), "tools": [{"name": tool["name"], "description": tool.get("description", "")} for tool in tools]}


@app.post("/api/chat")
async def chat(body: ChatRequest, request: Request):
    message = body.message
    if not message.strip() or len(message) > 8000:
        return JSONResponse({"error": "Provide a message with no more than 8,000 characters."}, status_code=400)
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key or api_key == "sk-your-key-here":
        return JSONResponse({"error": "OPENAI_API_KEY not configured"}, status_code=500)
    sid, token = await access_token(request)
    if not sid or not token:
        return auth_error("Connect your INDmoney account before chatting.")
    ref = chat_collection(sid).document(body.chatId)
    snapshot = ref.get()
    if not snapshot.exists:
        return JSONResponse({"error": "Chat not found in this account."}, status_code=404)
    data = snapshot.to_dict() or {}
    try:
        answer = await run_agent(message, api_key, MCP_RESOURCE, token, data.get("messages", []))
    except Exception as exc:
        logger.exception("Chat agent request failed")
        details = str(exc)
        status = 502
        if details.startswith("OpenAI request failed: HTTP 401"):
            status = 502
        return JSONResponse({"error": "INDmoney data request failed" if "INDmoney" in details or "MCP" in details else "Agent request failed", "details": details}, status_code=status)
    if answer.strip():
        now = datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
        messages = list(data.get("messages", []))
        messages += [{"role": "user", "content": message[:MAX_HISTORY_MESSAGE_CHARS]}, {"role": "assistant", "content": answer[:MAX_HISTORY_MESSAGE_CHARS]}]
        messages = messages[-MAX_HISTORY_MESSAGES:]
        title = data.get("title", "New chat")
        if title == "New chat":
            title = message[:60]
        ref.update({"messages": messages, "title": title, "updatedAt": int(time.time() * 1000), "sessionExpiresAt": now})
        session_ref(sid).update({"sessionExpiresAt": now, "updatedAt": int(time.time() * 1000)})
    return PlainTextResponse(answer)


@app.get("/")
async def index():
    return FileResponse(PUBLIC_DIR / "index.html")


if PUBLIC_DIR.exists():
    app.mount("/", StaticFiles(directory=PUBLIC_DIR), name="static")
