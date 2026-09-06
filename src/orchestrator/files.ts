import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "./preflight/run.js";
import type { FragilityReport } from "./fragility/index.js";

/**
 * Read-only file access for the panels: the tracked-file list (with the
 * fragility overlay merged in when a report is available) and single
 * file reads. Every path is confined to its root, symlinks included.
 */

export interface FileEntry {
  path: string;
  /** Present when a fragility report was supplied. */
  heat?: number;
  commits?: number;
  fixCommits?: number;
  markers?: number;
  lastTouched?: string | null;
}

export interface FileListing {
  root: string;
  files: FileEntry[];
  truncated: boolean;
  /** When the overlay came from a report, its window, so the UI can label it. */
  fragilityWindow: FragilityReport["window"] | null;
  /** Set when git could not list the directory (not a repository, git missing). */
  error?: string;
}

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 512 * 1024;

export async function listFiles(repoDir: string, fragility: FragilityReport | null): Promise<FileListing> {
  const r = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repoDir, timeoutMs: 60_000 });
  if (!r.ok) {
    const why = r.error ?? r.stderr.trim().split(/\r?\n/)[0] ?? `git exited ${r.code}`;
    return { root: repoDir, files: [], truncated: false, fragilityWindow: null, error: /not a git repository/i.test(why) ? `${repoDir} is not a git repository` : why };
  }
  const names = r.stdout.split("\0").filter(Boolean);
  const truncated = names.length > MAX_FILES;
  const byPath = new Map<string, FragilityReport["files"][number]>();
  if (fragility) for (const f of fragility.files) byPath.set(f.path, f);
  const files: FileEntry[] = names.slice(0, MAX_FILES).map((p) => {
    const f = byPath.get(p);
    return f
      ? { path: p, heat: f.heat, commits: f.commits, fixCommits: f.fixCommits, markers: f.markerTotal, lastTouched: f.lastTouched }
      : fragility
        ? { path: p, heat: 0, commits: 0, fixCommits: 0, markers: 0, lastTouched: null }
        : { path: p };
  });
  return { root: repoDir, files, truncated, fragilityWindow: fragility?.window ?? null };
}

export interface FileContent {
  path: string;
  bytes: number;
  content: string;
  truncated: boolean;
  binary: boolean;
  modified: string;
}

/** Resolves `rel` inside `root`, refusing traversal and symlinks that leave the root. */
export async function safeResolve(root: string, rel: string): Promise<string> {
  if (!rel || rel.includes("\0")) throw new FileAccessError("invalid path");
  const rootReal = await realpath(root);
  const abs = path.resolve(rootReal, rel);
  const relToRoot = path.relative(rootReal, abs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) throw new FileAccessError("path escapes the root");
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new FileAccessError("not found");
  }
  const relReal = path.relative(rootReal, real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) throw new FileAccessError("path escapes the root via a link");
  return real;
}

export async function readTextFile(root: string, rel: string): Promise<FileContent> {
  const abs = await safeResolve(root, rel);
  const st = await stat(abs);
  if (!st.isFile()) throw new FileAccessError("not a file");
  const buf = await readFile(abs);
  const head = buf.subarray(0, 8000);
  let binary = false;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) {
      binary = true;
      break;
    }
  }
  const truncated = buf.length > MAX_FILE_BYTES;
  return {
    path: rel,
    bytes: buf.length,
    content: binary ? "" : (truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf).toString("utf8"),
    truncated,
    binary,
    modified: st.mtime.toISOString(),
  };
}

export class FileAccessError extends Error {}
