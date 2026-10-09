# Code Mode Agent

A local Python web app that connects to INDmoney's MCP server and sends its tools directly to the AI model. INDmoney OAuth, chat history, and settings run on this computer. Chat history and OAuth sessions are stored in a local SQLite database at `.data/codemode.sqlite3`.

## Requirements

- Docker Desktop, or Python 3.12+
- An OpenAI API key
- An INDmoney account

## Run locally with Docker

```bash
cp .env.example .env
```

Add your OpenAI API key to `.env`, then start the app:

```bash
docker compose up --build
```

Open [http://localhost:8003](http://localhost:8003) and choose **Connect INDmoney**. OAuth will return to `http://localhost:8003/auth/indmoney/callback`. Keep using this same local address for the sign-in flow.

The SQLite database is stored in `.data/` and remains on this computer across restarts. Do not commit `.env` or `.data/`.
Use the sun/moon button in the header to switch between light and dark themes; the choice is remembered in this browser.

## Run with local Python

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Add your OpenAI API key to `.env`, then run:

```bash
uvicorn --env-file .env app.main:app --host 127.0.0.1 --port 8003
```

Open [http://localhost:8003](http://localhost:8003).

## Local data

OAuth tokens, chats, and chat history are stored in `.data/codemode.sqlite3`. Selecting **Disconnect** revokes the INDmoney access token and removes that local session and its chats.

## Project structure

```text
app/
  main.py          Local API, INDmoney OAuth, and SQLite persistence
  agent.py         OpenAI tool-call loop and conversation context
  mcp_client.py    INDmoney MCP discovery and tool calls
frontend/          Local website, styles, JavaScript, and PWA assets
  css/app.css      Interface styles
  js/app.js        Chat and visualization behavior
  index.html       App page structure
requirements.txt   Python dependencies
docker-compose.yml Local app container
Dockerfile         Python container image
```
