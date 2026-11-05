/**
 * Per-session workspace directories. All file tools and sandbox containers operate
 * inside `<DATA_DIR>/workspaces/<sessionId>`; paths are resolved and checked so
 * neither `..` segments nor symlinks can escape the workspace.
 */
import fs from "node:fs/promises";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const PACKAGES_DIR = ".packages";
const MAX_READ_BYTES = 1_000_000;
const MAX_WRITE_BYTES = 5_000_000;
const MAX_LIST = 500;

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export class WorkspaceManager {
  readonly root: string;

  constructor(
    dataDir: string,
    /** Host-side path of dataDir when the agent runs in a container (for sibling sandbox mounts). */
    private readonly hostDataDir?: string,
    private readonly dataDirRoot: string = dataDir
  ) {
    this.root = path.join(dataDir, "workspaces");
  }

  dirFor(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) throw new Error("Invalid session id");
    return path.join(this.root, sessionId);
  }

  async ensure(sessionId: string): Promise<string> {
    const dir = this.dirFor(sessionId);
    await fs.mkdir(dir, { recursive: true });
    // When the agent itself runs as root (inside its container), sandboxes run as uid 10001
    // and need write access to the bind-mounted session directory.
    if (typeof process.getuid === "function" && process.getuid() === 0) await fs.chmod(dir, 0o777).catch(() => {});
    return dir;
  }

  /** Path to mount into sandbox containers (translated to the host path when needed). */
  async mountPath(sessionId: string): Promise<string> {
    const dir = await this.ensure(sessionId);
    if (!this.hostDataDir) return dir;
    return path.join(this.hostDataDir, path.relative(this.dataDirRoot, dir));
  }

  /** Resolve a user-supplied relative path inside the workspace, rejecting escapes. */
  resolve(sessionId: string, rel: string): string {
    const base = this.dirFor(sessionId);
    const cleaned = (rel ?? "").replace(/^\/+/, "").replace(/^workspace\/?/, "");
    const target = path.resolve(base, cleaned || ".");
    if (target !== base && !target.startsWith(base + path.sep)) {
      throw new Error(`Path "${rel}" is outside the workspace`);
    }
    // Reject symlinks that point outside the workspace.
    let probe = target;
    while (!existsSync(probe) && probe !== base) probe = path.dirname(probe);
    if (existsSync(probe)) {
      const real = realpathSync(probe);
      const realBase = existsSync(base) ? realpathSync(base) : base;
      if (real !== realBase && !real.startsWith(realBase + path.sep)) {
        throw new Error(`Path "${rel}" resolves outside the workspace`);
      }
    }
    return target;
  }

  async list(sessionId: string, rel = "", includePackages = false): Promise<WorkspaceFile[]> {
    const base = await this.ensure(sessionId);
    const start = this.resolve(sessionId, rel);
    const out: WorkspaceFile[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_LIST) return;
        const full = path.join(dir, e.name);
        const relPath = path.relative(base, full);
        if (!includePackages && (relPath === PACKAGES_DIR || relPath.startsWith(PACKAGES_DIR + path.sep))) continue;
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          const st = await fs.stat(full);
          out.push({ path: relPath.split(path.sep).join("/"), size: st.size, modifiedAt: st.mtime.toISOString() });
        }
      }
    };
    await walk(start);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(sessionId: string, rel: string): Promise<{ path: string; content: string; truncated: boolean; size: number }> {
    const file = this.resolve(sessionId, rel);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) throw new Error(`File not found: ${rel}`);
    const handle = await fs.open(file, "r");
    try {
      const len = Math.min(st.size, MAX_READ_BYTES);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, 0);
      return { path: rel, content: buf.toString("utf8"), truncated: st.size > MAX_READ_BYTES, size: st.size };
    } finally {
      await handle.close();
    }
  }

  async write(sessionId: string, rel: string, content: string): Promise<WorkspaceFile> {
    if (typeof content !== "string") throw new Error("content must be a string");
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error(`File exceeds ${MAX_WRITE_BYTES} bytes`);
    await this.ensure(sessionId);
    const file = this.resolve(sessionId, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    const st = await fs.stat(file);
    return { path: rel.replace(/^\/+/, ""), size: st.size, modifiedAt: st.mtime.toISOString() };
  }

  async remove(sessionId: string, rel: string): Promise<{ deleted: string }> {
    const file = this.resolve(sessionId, rel);
    if (file === this.dirFor(sessionId)) throw new Error("Refusing to delete the workspace root");
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) throw new Error(`File not found: ${rel}`);
    await fs.unlink(file);
    return { deleted: rel };
  }

  stream(sessionId: string, rel: string) {
    const file = this.resolve(sessionId, rel);
    return { file, stream: createReadStream(file) };
  }
}
