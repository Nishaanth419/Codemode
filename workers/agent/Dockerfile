# AgentOS agent backend. Build context: repository root.
FROM node:24-slim

# Docker CLI only (talks to the host daemon through the mounted socket to start sandbox containers).
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json package-lock.json ./
COPY workers/agent/package.json workers/agent/
COPY apps/web/package.json apps/web/
RUN npm ci -w workers/agent --include-workspace-root=false --ignore-scripts

COPY workers/agent workers/agent
COPY sandbox sandbox
# MCP server config (MCP_CONFIG_FILE=mcp.json). Stdio servers run in this container; npx is available.
COPY mcp.json mcp.json

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
EXPOSE 8787
WORKDIR /app/workers/agent
CMD ["npx", "tsx", "--import", "./src/shims/register.ts", "src/index.ts"]
