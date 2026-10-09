"""OpenAI chat-completions loop with MCP tools passed directly to the model."""

from __future__ import annotations

import json
from typing import Any

import httpx

from .mcp_client import call_mcp_tool, fetch_mcp_session

SYSTEM_PROMPT = """You are a helpful assistant that answers questions using available INDmoney MCP tools. Use earlier user and assistant messages as context, especially for follow-up questions.

Call relevant tools directly when the user asks about their account. Use only data returned by tools; never invent holdings, balances, transactions, or performance. If a tool fails, report its exact error and do not claim that data was retrieved or retry speculatively.

When tool results contain comparable numeric data (such as holdings, allocations, balances over time, or category totals), proactively include one chart in a `chart` fenced block using valid JSON, for example:
```chart
{"type":"bar","title":"Current value by holding","unit":"₹","data":[{"label":"Fund A","value":125000}]}
```
Use `bar` to compare categories and `donut` for a part-to-whole split. Include only relevant items (usually 5–10), explain the largest concentration in the surrounding text, and chart only values returned by tools. If a tool fails or provides no numeric data, explain that clearly and do not fabricate a chart."""


async def run_agent(message: str, api_key: str, mcp_url: str, token: str, history: list[dict[str, str]]) -> str:
    session = await fetch_mcp_session(mcp_url, token)
    tools = session["tools"]
    tool_map = {tool["name"]: tool for tool in tools}
    model_tools = [
        {"type": "function", "function": {
            "name": tool["name"],
            "description": tool.get("description") or f"Call the {tool['name']} tool",
            "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}},
        }}
        for tool in tools
    ]
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend({"role": item["role"], "content": item["content"]} for item in history)
    messages.append({"role": "user", "content": message})

    async with httpx.AsyncClient(timeout=120) as client:
        for _ in range(5):
            payload: dict[str, Any] = {"model": "gpt-4o", "messages": messages}
            if model_tools:
                payload["tools"] = model_tools
                payload["tool_choice"] = "auto"
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            if not response.is_success:
                raise RuntimeError(f"OpenAI request failed: HTTP {response.status_code} {response.text[:800]}")
            choice = response.json()["choices"][0]["message"]
            calls = choice.get("tool_calls") or []
            if not calls:
                return choice.get("content") or ""
            messages.append({"role": "assistant", "content": choice.get("content"), "tool_calls": calls})
            for call in calls:
                function = call.get("function", {})
                name = function.get("name", "")
                if name not in tool_map:
                    raise RuntimeError(f"Model requested an unknown INDmoney tool: {name}")
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                    result = await call_mcp_tool(
                        mcp_url, token, session["protocolVersion"], session["sessionId"], name, arguments,
                    )
                except Exception as exc:
                    raise RuntimeError(f"INDmoney data request failed: {exc}") from exc
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": str(result)})
    return "I could not finish processing the INDmoney response within the tool-call limit."
