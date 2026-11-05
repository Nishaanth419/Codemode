# AgentOS execution sandbox image.
# One small image runs: Code Mode JavaScript (docker executor), Node.js, Python and shell.
# Containers from this image are started with --network none, a read-only root fs,
# dropped capabilities, and memory / CPU / PID limits (see workers/agent/src/sandbox/docker.ts).
FROM node:24-alpine

RUN apk add --no-cache python3 py3-pip bash coreutils \
 && ln -sf /usr/bin/python3 /usr/bin/python \
 && addgroup -S sandbox && adduser -S -G sandbox -u 10001 sandbox \
 && mkdir -p /workspace /runtime && chown sandbox:sandbox /workspace

COPY codemode-runtime.mjs /runtime/codemode-runtime.mjs

USER sandbox
WORKDIR /workspace
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 NPM_CONFIG_UPDATE_NOTIFIER=false
CMD ["sh"]
