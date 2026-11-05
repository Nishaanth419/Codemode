/**
 * Package installation with security restrictions.
 *
 * - Only `pip` and `npm` packages on the SANDBOX_ALLOWED_PACKAGES allowlist can be
 *   installed (entries look like `pip:requests` or `npm:lodash`; `pip:*` / `npm:*`
 *   allow any package for that manager and are off by default).
 * - Names and versions are validated against strict patterns, and packages are passed
 *   as argv (no shell), so nothing can be injected.
 * - Installs run in the same locked-down sandbox container; network is enabled only for
 *   the install, and packages land in the session workspace (`/workspace/.packages`),
 *   never in the image or on the host.
 * - npm lifecycle scripts are disabled (`--ignore-scripts`).
 * - pip installs are binary-only (`--only-binary=:all:`): prebuilt wheels, never source
 *   builds. Building runs arbitrary setup code and cannot succeed in the sandbox anyway
 *   (no compiler, noexec /tmp, tight memory), so it is rejected up front with a clear error.
 */
import fs from "node:fs";
import path from "node:path";
import type { DockerSandbox, SandboxRunResult } from "./docker.js";
import { PACKAGES_DIR } from "./workspace.js";

export type PackageManager = "pip" | "npm";

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
const VERSION_RE = /^[0-9][0-9a-zA-Z.+-]{0,40}$/;

export class PackageInstaller {
  private readonly allowed: Set<string>;

  constructor(
    private readonly sandbox: DockerSandbox,
    allowlist: string
  ) {
    this.allowed = new Set(
      allowlist
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  allowlist(): { manager: PackageManager; name: string }[] {
    return [...this.allowed].map((entry) => {
      const [manager, name] = entry.split(":");
      return { manager: manager as PackageManager, name };
    });
  }

  check(manager: string, name: string, version?: string): { ok: true } | { ok: false; reason: string } {
    if (manager !== "pip" && manager !== "npm") return { ok: false, reason: `Unsupported package manager "${manager}" (use pip or npm)` };
    if (!NAME_RE.test(name)) return { ok: false, reason: `Invalid package name "${name}"` };
    if (version !== undefined && version !== "" && !VERSION_RE.test(version)) return { ok: false, reason: `Invalid version "${version}"` };
    const key = `${manager}:${name.toLowerCase()}`;
    if (!this.allowed.has(key) && !this.allowed.has(`${manager}:*`)) {
      return { ok: false, reason: `Package "${name}" is not on the ${manager} allowlist (SANDBOX_ALLOWED_PACKAGES)` };
    }
    return { ok: true };
  }

  async install(mountDir: string, manager: PackageManager, name: string, version?: string): Promise<SandboxRunResult & { installed: string }> {
    const verdict = this.check(manager, name, version);
    if (!verdict.ok) throw new Error(verdict.reason);
    const spec = version ? (manager === "pip" ? `${name}==${version}` : `${name}@${version}`) : name;
    const argv =
      manager === "pip"
        ? ["pip", "install", "--no-cache-dir", "--disable-pip-version-check", "--only-binary=:all:", "--target", "/workspace/.packages/python", spec]
        : ["npm", "install", "--no-audit", "--no-fund", "--ignore-scripts", "--prefix", "/workspace/.packages/node", spec];
    // Unpack on disk, not in /tmp: /tmp is a tmpfs whose pages count against the container's
    // memory limit, and unpacking wheels such as matplotlib + numpy there exceeds 256 MB.
    const hostTmp = path.join(mountDir, PACKAGES_DIR, ".tmp");
    fs.mkdirSync(hostTmp, { recursive: true });
    const tmp = `/workspace/${PACKAGES_DIR}/.tmp`;
    let result: SandboxRunResult;
    try {
      result = await this.sandbox.run({
        mountDir,
        argv,
        network: "bridge",
        timeoutMs: 180_000,
        env: { TMPDIR: tmp, npm_config_cache: `${tmp}/npm` }
      });
    } finally {
      fs.rmSync(hostTmp, { recursive: true, force: true });
    }
    if (manager === "pip" && result.exitCode !== 0 && /No matching distribution|from versions: none/i.test(result.stderr)) {
      result.stderr +=
        `\n[AgentOS] No prebuilt wheel of ${spec} exists for this sandbox's Python and platform. ` +
        "Source builds are not supported: install without a version pin (latest has wheels) or pick a version that ships wheels.";
    }
    return { ...result, installed: spec };
  }
}
