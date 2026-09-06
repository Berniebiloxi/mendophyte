import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "../preflight/run.js";

/**
 * Phase 2 fragility-map inputs, from real signals only:
 *   - churn: how often each file changed (`git log --numstat`)
 *   - fix/revert clustering: commits whose subject says fix/revert, and
 *     which files and directories they concentrate in
 *   - TODO/FIXME/HACK/XXX density (`git grep`)
 *   - the weak signal: files with no commits in the window
 *
 * Nothing here is a verdict. Every number is traceable to a command,
 * and fix clusters carry example commits so the agent can cite them.
 */

export interface FragilityOptions {
  repoDir: string;
  /** Passed to `git log --since`. Default "3 years". */
  since?: string;
  /** Cap on commits scanned (newest first). Default 5000. */
  maxCommits?: number;
  /** Narrow everything to one directory (relative, forward slashes). */
  subpath?: string;
  /** Size of the "top" lists. Default 15. */
  topN?: number;
}

export interface CommitRef {
  sha: string;
  short: string;
  date: string;
  subject: string;
}

export interface MarkerCounts {
  TODO: number;
  FIXME: number;
  HACK: number;
  XXX: number;
}

export interface FileFragility {
  path: string;
  commits: number;
  added: number;
  deleted: number;
  fixCommits: number;
  revertCommits: number;
  /** Up to 3 fix/revert commits touching this file, newest first. */
  fixExamples: CommitRef[];
  firstTouched: string | null;
  lastTouched: string | null;
  markers: MarkerCounts;
  markerTotal: number;
  /** Line count, only computed for files that carry markers. */
  lines: number | null;
  markersPerKloc: number | null;
  /**
   * UI convenience only: a 0-1 blend of the three signals, each scaled
   * by its maximum across the repo (0.4 churn, 0.4 fixes, 0.2 markers).
   * Never cite this; cite the raw counts it was built from.
   */
  heat: number;
}

export interface DirFragility {
  path: string;
  files: number;
  commits: number;
  fixCommits: number;
  revertCommits: number;
  markerTotal: number;
}

export interface FragilityReport {
  ranAt: string;
  repoDir: string;
  subpath: string | null;
  window: {
    since: string;
    maxCommits: number;
    commitsScanned: number;
    truncated: boolean;
    oldest: string | null;
    newest: string | null;
    fixCommits: number;
    revertCommits: number;
  };
  trackedFiles: number;
  /** Every tracked file with at least one non-zero signal, hottest first. */
  files: FileFragility[];
  top: {
    churn: FileFragility[];
    fixes: FileFragility[];
    markers: FileFragility[];
  };
  /** Directories (depth <= 3) ranked by commits; a commit counts once per directory. */
  directories: DirFragility[];
  /** Directories ranked by fix commits, the "where do fixes cluster" view. */
  fixClusters: DirFragility[];
  markerTotals: MarkerCounts;
  markerFiles: number;
  stale: {
    /** Tracked files with no commit inside the window. */
    count: number;
    /** Top-level directories holding the most such files. */
    byTopDir: [string, number][];
  };
  sources: string[];
  error?: string;
}

export const FIX_SUBJECT = /\b(fix|fixes|fixed|fixing|bugfix|bug-fix|hotfix|regression|revert|reverts|reverted)\b/i;
export const REVERT_SUBJECT = /\b(revert|reverts|reverted)\b/i;
export const MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b/g;

const emptyMarkers = (): MarkerCounts => ({ TODO: 0, FIXME: 0, HACK: 0, XXX: 0 });

/** Normalises git's rename notation (`a/{b => c}/d`, `old => new`) to the new path. */
export function normalizeNumstatPath(p: string): string {
  let s = p.trim();
  if (s.includes("{") && s.includes(" => ")) {
    s = s.replace(/\{([^{}]*) => ([^{}]*)\}/g, (_m, _a, b) => b);
    s = s.replace(/\/\//g, "/").replace(/^\/+/, "");
  } else if (s.includes(" => ")) {
    s = s.split(" => ")[1];
  }
  return s;
}

function dirPrefixes(file: string, maxDepth = 3): string[] {
  const parts = file.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length && i <= maxDepth; i++) out.push(parts.slice(0, i).join("/") + "/");
  return out;
}

const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

export async function computeFragility(opts: FragilityOptions): Promise<FragilityReport> {
  const since = opts.since ?? "3 years";
  const maxCommits = opts.maxCommits ?? 5000;
  const topN = opts.topN ?? 15;
  const subpath = opts.subpath ? opts.subpath.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "") || null : null;
  const ranAt = new Date().toISOString();
  const sources: string[] = [];

  const base: FragilityReport = {
    ranAt,
    repoDir: opts.repoDir,
    subpath,
    window: { since, maxCommits, commitsScanned: 0, truncated: false, oldest: null, newest: null, fixCommits: 0, revertCommits: 0 },
    trackedFiles: 0,
    files: [],
    top: { churn: [], fixes: [], markers: [] },
    directories: [],
    fixClusters: [],
    markerTotals: emptyMarkers(),
    markerFiles: 0,
    stale: { count: 0, byTopDir: [] },
    sources,
  };

  // ---- tracked files
  const lsArgs = ["ls-files", "-z"];
  if (subpath) lsArgs.push("--", subpath);
  const ls = await run("git", lsArgs, { cwd: opts.repoDir, timeoutMs: 60_000 });
  if (!ls.ok) return { ...base, error: `git ls-files failed: ${ls.error ?? ls.stderr.trim()}` };
  sources.push(ls.cmd);
  const tracked = new Set(ls.stdout.split("\0").filter(Boolean));
  base.trackedFiles = tracked.size;

  // ---- git log --numstat
  const logArgs = ["log", "--no-merges", "--numstat", `--since=${since}`, `-n`, String(maxCommits), "--format=%x01%H%x1f%at%x1f%s"];
  if (subpath) logArgs.push("--", subpath);
  const log = await run("git", logArgs, { cwd: opts.repoDir, timeoutMs: 180_000 });
  if (!log.ok) return { ...base, error: `git log failed: ${log.error ?? log.stderr.trim()}` };
  sources.push(`git log --no-merges --numstat --since="${since}" -n ${maxCommits}${subpath ? ` -- ${subpath}` : ""}`);

  const files = new Map<string, FileFragility>();
  const dirs = new Map<string, DirFragility & { fileSet: Set<string> }>();
  const getFile = (p: string): FileFragility => {
    let f = files.get(p);
    if (!f) {
      f = {
        path: p,
        commits: 0,
        added: 0,
        deleted: 0,
        fixCommits: 0,
        revertCommits: 0,
        fixExamples: [],
        firstTouched: null,
        lastTouched: null,
        markers: emptyMarkers(),
        markerTotal: 0,
        lines: null,
        markersPerKloc: null,
        heat: 0,
      };
      files.set(p, f);
    }
    return f;
  };
  const getDir = (d: string) => {
    let x = dirs.get(d);
    if (!x) {
      x = { path: d, files: 0, commits: 0, fixCommits: 0, revertCommits: 0, markerTotal: 0, fileSet: new Set() };
      dirs.set(d, x);
    }
    return x;
  };

  let commitsScanned = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let fixCommits = 0;
  let revertCommits = 0;

  let cur: { ref: CommitRef; ts: number; isFix: boolean; isRevert: boolean; dirsSeen: Set<string> } | null = null;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith("\x01")) {
      const [sha, at, subject] = line.slice(1).split("\x1f");
      const ts = Number(at);
      commitsScanned++;
      oldest = oldest === null ? ts : Math.min(oldest, ts);
      newest = newest === null ? ts : Math.max(newest, ts);
      const isFix = FIX_SUBJECT.test(subject);
      const isRevert = REVERT_SUBJECT.test(subject);
      if (isFix) fixCommits++;
      if (isRevert) revertCommits++;
      cur = { ref: { sha, short: sha.slice(0, 7), date: iso(ts), subject: subject.slice(0, 120) }, ts, isFix, isRevert, dirsSeen: new Set() };
      continue;
    }
    if (!cur || !line.trim()) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const p = normalizeNumstatPath(m[3]);
    if (!tracked.has(p)) continue;
    const f = getFile(p);
    f.commits++;
    if (m[1] !== "-") f.added += Number(m[1]);
    if (m[2] !== "-") f.deleted += Number(m[2]);
    const d = iso(cur.ts);
    if (!f.lastTouched || d > f.lastTouched) f.lastTouched = d;
    if (!f.firstTouched || d < f.firstTouched) f.firstTouched = d;
    if (cur.isFix) {
      f.fixCommits++;
      if (f.fixExamples.length < 3) f.fixExamples.push(cur.ref);
    }
    if (cur.isRevert) f.revertCommits++;
    for (const dp of dirPrefixes(p)) {
      const dd = getDir(dp);
      dd.fileSet.add(p);
      if (!cur.dirsSeen.has(dp)) {
        cur.dirsSeen.add(dp);
        dd.commits++;
        if (cur.isFix) dd.fixCommits++;
        if (cur.isRevert) dd.revertCommits++;
      }
    }
  }

  base.window = {
    since,
    maxCommits,
    commitsScanned,
    truncated: commitsScanned >= maxCommits,
    oldest: oldest === null ? null : iso(oldest),
    newest: newest === null ? null : iso(newest),
    fixCommits,
    revertCommits,
  };

  // ---- markers
  const grepArgs = ["grep", "-n", "-I", "-E", "\\b(TODO|FIXME|HACK|XXX)\\b", "--"];
  grepArgs.push(subpath ?? ".");
  const grep = await run("git", grepArgs, { cwd: opts.repoDir, timeoutMs: 120_000 });
  // exit 1 = no matches, which is fine
  if (grep.ok || grep.code === 1) {
    sources.push("git grep -n -I -E '\\b(TODO|FIXME|HACK|XXX)\\b'");
    for (const line of grep.stdout.split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const p = line.slice(0, idx);
      if (!tracked.has(p)) continue;
      const text = line.slice(line.indexOf(":", idx + 1) + 1);
      const f = getFile(p);
      for (const mm of text.matchAll(MARKER_RE)) {
        const k = mm[1] as keyof MarkerCounts;
        f.markers[k]++;
        f.markerTotal++;
        base.markerTotals[k]++;
      }
    }
  }

  // line counts for marker files (bounded)
  const markerFiles = [...files.values()].filter((f) => f.markerTotal > 0);
  base.markerFiles = markerFiles.length;
  for (const f of markerFiles.slice(0, 2000)) {
    try {
      const abs = path.join(opts.repoDir, f.path);
      const st = await stat(abs);
      if (st.size > 2 * 1024 * 1024) continue;
      const buf = await readFile(abs);
      let n = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
      if (buf.length && buf[buf.length - 1] !== 10) n++;
      f.lines = n;
      f.markersPerKloc = n ? Math.round((f.markerTotal / n) * 1000 * 10) / 10 : null;
    } catch {
      /* unreadable; leave null */
    }
    for (const dp of dirPrefixes(f.path)) {
      const dd = getDir(dp);
      dd.fileSet.add(f.path);
      dd.markerTotal += f.markerTotal;
    }
  }

  // ---- heat
  const all = [...files.values()];
  const maxC = Math.max(1, ...all.map((f) => f.commits));
  const maxF = Math.max(1, ...all.map((f) => f.fixCommits));
  const maxM = Math.max(1, ...all.map((f) => f.markerTotal));
  for (const f of all) {
    f.heat = Math.round((0.4 * (f.commits / maxC) + 0.4 * (f.fixCommits / maxF) + 0.2 * (f.markerTotal / maxM)) * 1000) / 1000;
  }
  all.sort((a, b) => b.heat - a.heat || b.commits - a.commits || a.path.localeCompare(b.path));
  base.files = all;
  base.top = {
    churn: [...all].filter((f) => f.commits > 0).sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path)).slice(0, topN),
    fixes: [...all].filter((f) => f.fixCommits > 0).sort((a, b) => b.fixCommits - a.fixCommits || b.commits - a.commits || a.path.localeCompare(b.path)).slice(0, topN),
    markers: [...all].filter((f) => f.markerTotal > 0).sort((a, b) => b.markerTotal - a.markerTotal || a.path.localeCompare(b.path)).slice(0, topN),
  };

  const dirList: DirFragility[] = [...dirs.values()].map(({ fileSet, ...d }) => ({ ...d, files: fileSet.size }));
  base.directories = [...dirList].sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path)).slice(0, topN);
  base.fixClusters = [...dirList].filter((d) => d.fixCommits > 0).sort((a, b) => b.fixCommits - a.fixCommits || a.path.localeCompare(b.path)).slice(0, topN);

  // ---- stale (weak)
  const staleTop = new Map<string, number>();
  let staleCount = 0;
  for (const p of tracked) {
    const f = files.get(p);
    if (f && f.commits > 0) continue;
    staleCount++;
    const slash = p.indexOf("/");
    const d = slash === -1 ? "(root)" : p.slice(0, slash) + "/";
    staleTop.set(d, (staleTop.get(d) ?? 0) + 1);
  }
  base.stale = { count: staleCount, byTopDir: [...staleTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) };

  return base;
}
