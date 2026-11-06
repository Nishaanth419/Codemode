#!/usr/bin/env bash
# AgentOS local runner.
#
#   ./run.sh              check prerequisites, then start the agent (:8787) and the web UI (:5173)
#   ./run.sh --open       same, and open the UI in your browser once it is up
#   ./run.sh check        only check prerequisites (Node, deps, .env, Docker, sandbox image, ports)
#   ./run.sh test         typecheck + all tests
#   ./run.sh docker       full stack in Docker Compose (UI on :8080, or WEB_PORT)
#
# Ports: AGENT_PORT=8788 WEB_PORT=5174 ./run.sh
# Ctrl+C stops everything this script started.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

AGENT_PORT="${AGENT_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-agentos-sandbox:latest}"
MIN_NODE="22.13"

# ── output ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; LIME=$'\033[38;5;191m'; X=$'\033[0m'
else
  B=""; DIM=""; R=""; G=""; Y=""; C=""; LIME=""; X=""
fi
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$X" "$*"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  %s✗%s %s\n' "$R" "$X" "$*" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$X"; }
WARNINGS=0

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

# ── checks ───────────────────────────────────────────────────────────────────
check_node() {
  command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node ${MIN_NODE} or newer (https://nodejs.org)."
  local v; v="$(node -p 'process.versions.node')"
  node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    const [ma, mb] = process.argv[1].split(".").map(Number);
    process.exit(a > ma || (a === ma && b >= mb) ? 0 : 1);
  ' "$MIN_NODE" || fail "Node ${v} is too old. AgentOS needs ${MIN_NODE}+ (it uses the built-in node:sqlite)."
  ok "Node ${v}"
}

check_deps() {
  # Install when node_modules is missing or package-lock.json changed since the last install.
  if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    printf '  %s…%s installing dependencies (npm install)\n' "$C" "$X"
    npm install --no-audit --no-fund --loglevel=error >/dev/null || fail "npm install failed. Run it yourself to see why."
    ok "dependencies installed"
  else
    ok "dependencies up to date"
  fi
}

env_value() { # value of KEY in .env, without quotes; empty when unset
  local line
  line="$(grep -E "^[[:space:]]*$1=" .env 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"; line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

check_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    warn "created .env from .env.example. Add GROQ_API_KEY and/or GEMINI_API_KEY to it (or set OLLAMA_ENABLED=true)."
  fi

  local providers=""
  [ -n "$(env_value GROQ_API_KEY)" ] && providers="${providers} Groq"
  [ -n "$(env_value GEMINI_API_KEY)" ] && providers="${providers} Gemini"
  [ "$(env_value OLLAMA_ENABLED)" = "true" ] && providers="${providers} Ollama"
  if [ -n "$providers" ]; then
    ok ".env: LLM providers:${providers}"
  else
    warn ".env: no LLM provider. Set GROQ_API_KEY and/or GEMINI_API_KEY, or OLLAMA_ENABLED=true. The UI will start but cannot answer."
  fi

  # Settings added to .env.example after this .env was created.
  local missing="" key
  for key in $(grep -E '^[A-Z][A-Z0-9_]*=' .env.example | cut -d= -f1); do
    grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" .env || missing="${missing} ${key}"
  done
  if [ -n "$missing" ]; then
    warn ".env is missing settings that .env.example has:${missing}. Their defaults apply; copy them from .env.example to change them."
    case " $missing " in *" MCP_CONFIG_FILE "*) warn "without MCP_CONFIG_FILE=mcp.json no MCP servers are connected." ;; esac
  fi
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker not found. The UI and agent run, but sandbox.runPython / runNode / runShell / installPackage will fail."
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "Docker is installed but not running. Start Docker Desktop for the Python / Node / shell sandbox."
    return
  fi
  ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

  # Always build: with the layer cache this takes a second when nothing changed,
  # and it guarantees the image matches sandbox/ after a pull.
  local had_image=1
  docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1 || had_image=0
  [ "$had_image" = 0 ] && printf '  %s…%s building sandbox image %s (first run takes a minute)\n' "$C" "$X" "$SANDBOX_IMAGE"
  if docker build -q -t "$SANDBOX_IMAGE" sandbox >/dev/null 2>&1; then
    ok "sandbox image ${SANDBOX_IMAGE}"
  else
    warn "building ${SANDBOX_IMAGE} failed. Run: docker build -t ${SANDBOX_IMAGE} sandbox"
  fi
}

port_owner() { # "node (pid 123)" for the process listening on a port; empty when free
  { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR==2 {print $1 " (pid " $2 ")"}'
}

check_ports() {
  local p owner
  for p in "$AGENT_PORT" "$WEB_PORT"; do
    owner="$(port_owner "$p")"
    if [ -n "$owner" ]; then
      fail "port ${p} is already in use by ${owner}. Stop it, or pick other ports: AGENT_PORT=8788 WEB_PORT=5174 ./run.sh"
    fi
  done
  ok "ports ${AGENT_PORT} (agent) and ${WEB_PORT} (web) are free"
}

preflight() {
  step "Checking prerequisites"
  check_node
  check_deps
  check_env
  check_docker
  check_ports
}

# ── process management ───────────────────────────────────────────────────────
PIDS=""

kill_tree() { # kill a process and all of its descendants
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  if [ -n "$PIDS" ]; then
    printf '\n%sStopping AgentOS…%s\n' "$DIM" "$X"
    local pid
    for pid in $PIDS; do kill_tree "$pid"; done
    wait 2>/dev/null || true
  fi
}

prefix() { # prefix each line of output with a coloured label
  local label="$1" color="$2" line
  while IFS= read -r line; do printf '%s%-5s%s │ %s\n' "$color" "$label" "$X" "$line"; done
}

start() { # start NAME COLOR CMD...
  local name="$1" color="$2"; shift 2
  ( "$@" 2>&1 | prefix "$name" "$color" ) &
  PIDS="${PIDS} $!"
}

wait_for() { # wait_for URL SECONDS NAME
  local i=0
  while [ "$i" -lt "$2" ]; do
    curl -fsS -o /dev/null "$1" 2>/dev/null && return 0
    for pid in $PIDS; do kill -0 "$pid" 2>/dev/null || fail "$3 exited during start-up. See its output above."; done
    sleep 1; i=$((i + 1))
  done
  fail "$3 did not answer on $1 within $2s."
}

mcp_settled() { # true when no MCP server is still connecting (they start after the agent answers)
  curl -fsS "http://127.0.0.1:${AGENT_PORT}/api/status" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.exit((JSON.parse(s).mcp?.servers ?? []).some((m) => m.state === "connecting") ? 1 : 0); } catch { process.exit(0); }
    });'
}

status_summary() { # one line per provider / MCP server from /api/status
  curl -fsS "http://127.0.0.1:${AGENT_PORT}/api/status" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const st = JSON.parse(s);
        const llm = (st.llm?.providers ?? []).map((p) => `${p.label ?? p.name} ${p.configured ? p.status : "no key"}`).join(" · ");
        console.log(`  LLM       ${llm}${st.llm?.currentProvider ? `  (next: ${st.llm.currentProvider})` : ""}`);
        const ex = st.executor?.label ?? st.executor?.id ?? st.executor;
        if (ex) console.log(`  Executor  ${ex}`);
        const mcp = st.mcp?.servers ?? st.mcp ?? [];
        if (Array.isArray(mcp)) console.log(`  MCP       ${mcp.length ? mcp.map((m) => `${m.namespace ?? m.name} ${m.state ?? ""}${m.state === "connected" ? ` (${m.toolCount} tools)` : m.error ? ` (${m.error})` : ""}`.trim()).join(" · ") : "none configured"}`);
      } catch { /* status shape changed: skip the summary */ }
    });'
}

run_dev() {
  local open_browser="$1"
  preflight

  step "Starting AgentOS"
  # Ctrl+C / kill: exit at once (status 130); the EXIT trap then stops both servers.
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  start agent "$LIME" env PORT="$AGENT_PORT" npm run --silent dev -w workers/agent
  wait_for "http://127.0.0.1:${AGENT_PORT}/api/status" 90 "The agent"
  start web "$C" env AGENT_URL="http://127.0.0.1:${AGENT_PORT}" npm run --silent dev -w apps/web -- --port "$WEB_PORT" --strictPort
  wait_for "http://localhost:${WEB_PORT}/" 60 "The web UI"

  printf '\n%s  AgentOS is running%s\n\n' "$B$LIME" "$X"
  printf '  Workspace     %shttp://localhost:%s%s\n' "$B" "$WEB_PORT" "$X"
  printf '  How it works  http://localhost:%s/#how-it-works\n' "$WEB_PORT"
  printf '  Agent API     http://127.0.0.1:%s/api/status\n' "$AGENT_PORT"
  local i=0
  while [ "$i" -lt 30 ] && ! mcp_settled; do sleep 1; i=$((i + 1)); done
  status_summary || true
  [ "$WARNINGS" -gt 0 ] && printf '\n  %s%d warning(s) above.%s\n' "$Y" "$WARNINGS" "$X"
  printf '\n  %sCtrl+C to stop. Logs follow.%s\n\n' "$DIM" "$X"

  if [ "$open_browser" = 1 ] && command -v open >/dev/null 2>&1; then open "http://localhost:${WEB_PORT}"; fi

  # Stay up while both run; if one stops, stop the other.
  while :; do
    for pid in $PIDS; do
      if ! kill -0 "$pid" 2>/dev/null; then
        printf '\n%sA server stopped; shutting down the other.%s\n' "$Y" "$X"
        exit 1
      fi
    done
    sleep 1
  done
}

run_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || fail "Docker is not running."
  [ -f .env ] || { cp .env.example .env; warn "created .env from .env.example. Add your API keys, then run again."; }
  step "Starting the full stack in Docker (UI on http://localhost:${WEB_PORT:-8080})"
  exec docker compose up --build
}

run_tests() {
  step "Checking prerequisites"
  check_node
  check_deps
  step "Typecheck"
  npm run --silent typecheck
  step "Tests"
  npm test
}

# ── main ─────────────────────────────────────────────────────────────────────
OPEN=0
CMD="dev"
for arg in "$@"; do
  case "$arg" in
    --open) OPEN=1 ;;
    -h|--help|help) usage; exit 0 ;;
    dev|check|test|docker) CMD="$arg" ;;
    *) printf 'Unknown argument: %s\n\n' "$arg" >&2; usage; exit 2 ;;
  esac
done

case "$CMD" in
  dev) run_dev "$OPEN" ;;
  check) preflight; step "Ready"; printf '  Run %s./run.sh%s to start.\n' "$B" "$X" ;;
  test) run_tests ;;
  docker)
    [ "$WEB_PORT" = 5173 ] && unset WEB_PORT # compose has its own default (8080)
    run_docker ;;
esac
