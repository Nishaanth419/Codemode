# AgentOS execution sandbox image.
# One small image runs: Code Mode JavaScript (docker executor), Node.js, Python and shell.
# Containers from this image are started with --network none, a read-only root fs,
# dropped capabilities, and memory / CPU / PID limits (see workers/agent/src/sandbox/docker.ts).
#
# Debian (glibc), not Alpine (musl): PyPI publishes manylinux wheels for numpy, pandas,
# matplotlib and friends, but often no musllinux wheel for the newest Python. Without a
# wheel pip falls back to compiling from source, which cannot work in the sandbox
# (no compiler, noexec /tmp, 256 MB memory). Package installs are binary-only.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates bash coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/python3 /usr/bin/python \
 && groupadd --system --gid 10001 sandbox \
 && useradd --system --uid 10001 --gid sandbox --home-dir /tmp --shell /usr/sbin/nologin sandbox \
 && mkdir -p /workspace /runtime && chown sandbox:sandbox /workspace

COPY codemode-runtime.mjs /runtime/codemode-runtime.mjs

USER sandbox
WORKDIR /workspace
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1 NPM_CONFIG_UPDATE_NOTIFIER=false
CMD ["sh"]
