"""Small Streamable HTTP MCP client used for INDmoney tool discovery/calls."""

from __future__ import annotations

import json
from typing import Any

import httpx

DEFAULT_PROTOCOL_VERSION = "2025-03-26"


def _headers(token: str, protocol: str = DEFAULT_PROTOCOL_VERSION, session_id: str | None = None) -> dict[str, str]:
    result = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
        "MCP-Protocol-Version": protocol,
    }
    if session_id:
        result["mcp-session-id"] = session_id
    return result


def _rpc_body(response: httpx.Response) -> dict[str, Any] | None:
    content_type = response.headers.get("content-type", "")
    if "text/event-stream" in content_type:
        for line in response.text.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload and payload != "[DONE]":
                    return json.loads(payload)
        return None
    if not response.content:
        return None
    return response.json()


async def _post(client: httpx.AsyncClient, url: str, headers: dict[str, str], payload: dict[str, Any]) -> httpx.Response:
    return await client.post(url, headers=headers, json=payload)


async def fetch_mcp_session(url: str, token: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=45) as client:
        init = await _post(client, url, _headers(token), {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": DEFAULT_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "code-mode-agent", "version": "1.0.0"},
            },
        })
        if not init.is_success:
            challenge = init.headers.get("www-authenticate")
            hint = " INDmoney rejected the saved OAuth token; reconnect the account." if init.status_code == 401 else ""
            if init.status_code == 401 and not token:
                hint = " INDmoney requires OAuth sign-in; this request has no user token."
            raise RuntimeError(
                f"MCP initialize failed: {init.status_code} {init.reason_phrase}.{hint}"
                f"{f' WWW-Authenticate: {challenge}.' if challenge else ''}"
                f"{f' Response: {init.text[:500]}' if init.text else ''}"
            )
        result = _rpc_body(init)
        if not result or "result" not in result:
            raise RuntimeError(f"MCP initialize returned unexpected result: {result!r}")
        session_id = init.headers.get("mcp-session-id")
        protocol = result["result"].get("protocolVersion") or init.headers.get("MCP-Protocol-Version") or DEFAULT_PROTOCOL_VERSION
        headers = _headers(token, protocol, session_id)
        await _post(client, url, headers, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools_response = await _post(client, url, headers, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        })
        if not tools_response.is_success:
            raise RuntimeError(f"MCP tools/list failed: {tools_response.status_code} {tools_response.text[:500]}")
        tools_result = _rpc_body(tools_response)
        tools = (tools_result or {}).get("result", {}).get("tools")
        if not isinstance(tools, list):
            raise RuntimeError(f"MCP tools/list returned unexpected result: {tools_result!r}")
        return {"tools": tools, "sessionId": session_id, "protocolVersion": protocol}


async def call_mcp_tool(url: str, token: str, protocol: str, session_id: str | None, name: str, arguments: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=90) as client:
        response = await _post(client, url, _headers(token, protocol, session_id), {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
    if not response.is_success:
        raise RuntimeError(f'MCP tools/call failed for "{name}": {response.status_code} {response.text[:500]}')
    rpc = _rpc_body(response) or {}
    if rpc.get("error"):
        raise RuntimeError(f'MCP tools/call error for "{name}": {rpc["error"].get("message", rpc["error"])}')
    result = rpc.get("result") or {}
    content = result.get("content")
    if result.get("isError") is True:
        rendered = "\n".join(str(item.get("text", item)) for item in content or [])
        raise RuntimeError(f'MCP tool "{name}" failed: {rendered or result}')
    if isinstance(content, list):
        return "\n".join(str(item.get("text", json.dumps(item, ensure_ascii=False))) for item in content)
    return result
