import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./run.js";

/**
 * Local facts that fall out of the same pre-flight pass:
 *  - step 0: what already exists in the artifact home
 *  - repository state (branch, upstream, dirtiness) for the resume check
 *  - step 9: a rough scale read from `git ls-files`
 *  - step 10: the machine this is running on (the user still answers what
 *    they test against; this just stops the agent guessing the OS)
 */

export interface ArtifactEntry {
  name: string;
  bytes: number;
  modified: string;
  isDir: boolean;
}

export interface GitState {
  isRepo: boolean;
  topLevel: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyFiles: number | null;
  remotes: { name: string; url: string }[];
  gitVersion: string | null;
}

export interface ScaleReport {
  trackedFiles: number | null;
  /** Top extensions by tracked-file count, e.g. [[".rs", 412], [".md", 30]]. */
  topExtensions: [string, number][];
  /** Top first-level directories by tracked-file count. */
  topDirectories: [string, number][];
}

export interface EnvironmentReport {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  cpuModel: string | null;
  cpuCount: number;
  totalMemGb: number;
  node: string;
  wsl: boolean;
  container: boolean;
  shell: string | null;
}

export async function listArtifactHome(artifactHome: string): Promise<{ exists: boolean; entries: ArtifactEntry[] }> {
  let names: string[];
  try {
    names = await readdir(artifactHome);
  } catch {
    return { exists: false, entries: [] };
  }
  const entries: ArtifactEntry[] = [];
  for (const name of names.sort()) {
    try {
      const st = await stat(path.join(artifactHome, name));
      entries.push({ name, bytes: st.size, modified: st.mtime.toISOString(), isDir: st.isDirectory() });
    } catch {
      // vanished between readdir and stat; ignore
    }
  }
  return { exists: true, entries };
}

export async function readGitState(repoDir: string): Promise<GitState> {
  const g = (...args: string[]) => run("git", args, { cwd: repoDir, timeoutMs: 15_000 });
  const version = await run("git", ["--version"], { timeoutMs: 5_000 });
  const gitVersion = version.ok ? version.stdout.trim().replace(/^git version\s*/, "") : null;

  const top = await g("rev-parse", "--show-toplevel");
  if (!top.ok) {
    return { isRepo: false, topLevel: null, branch: null, head: null, upstream: null, ahead: null, behind: null, dirtyFiles: null, remotes: [], gitVersion };
  }

  const [branch, head, upstream, status, remotes] = await Promise.all([
    g("rev-parse", "--abbrev-ref", "HEAD"),
    g("rev-parse", "--short", "HEAD"),
    g("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"),
    g("status", "--porcelain"),
    g("remote", "-v"),
  ]);

  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream.ok) {
    const counts = await g("rev-list", "--left-right", "--count", "@{u}...HEAD");
    if (counts.ok) {
      const [b, a] = counts.stdout.trim().split(/\s+/).map(Number);
      behind = Number.isFinite(b) ? b : null;
      ahead = Number.isFinite(a) ? a : null;
    }
  }

  const remoteList: { name: string; url: string }[] = [];
  if (remotes.ok) {
    for (const line of remotes.stdout.split(/\r?\n/)) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
      if (m) remoteList.push({ name: m[1], url: m[2] });
    }
  }

  return {
    isRepo: true,
    topLevel: top.stdout.trim(),
    branch: branch.ok ? branch.stdout.trim() : null,
    head: head.ok ? head.stdout.trim() : null,
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    ahead,
    behind,
    dirtyFiles: status.ok ? status.stdout.split(/\r?\n/).filter((l) => l.trim()).length : null,
    remotes: remoteList,
    gitVersion,
  };
}

export async function readScale(repoDir: string): Promise<ScaleReport> {
  const r = await run("git", ["ls-files", "-z"], { cwd: repoDir, timeoutMs: 30_000 });
  if (!r.ok) return { trackedFiles: null, topExtensions: [], topDirectories: [] };
  const files = r.stdout.split("\0").filter(Boolean);
  const ext = new Map<string, number>();
  const dirs = new Map<string, number>();
  for (const f of files) {
    const base = path.posix.basename(f);
    const dot = base.lastIndexOf(".");
    const e = dot > 0 ? base.slice(dot).toLowerCase() : "(none)";
    ext.set(e, (ext.get(e) ?? 0) + 1);
    const slash = f.indexOf("/");
    const d = slash === -1 ? "(root)" : f.slice(0, slash) + "/";
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number): [string, number][] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  return { trackedFiles: files.length, topExtensions: top(ext, 8), topDirectories: top(dirs, 8) };
}

export async function readEnvironment(): Promise<EnvironmentReport> {
  let wsl = false;
  let container = false;
  if (process.platform === "linux") {
    try {
      const v = await readFile("/proc/version", "utf8");
      wsl = /microsoft|wsl/i.test(v);
    } catch {
      /* not linux-like */
    }
    try {
      await stat("/.dockerenv");
      container = true;
    } catch {
      try {
        const cg = await readFile("/proc/1/cgroup", "utf8");
        container = /docker|containerd|kubepods|lxc|podman/i.test(cg);
      } catch {
        /* ignore */
      }
    }
  }
  const cpus = os.cpus();
  return {
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() ?? null,
    cpuCount: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    wsl,
    container,
    shell: process.env.SHELL ?? process.env.ComSpec ?? null,
  };
}
