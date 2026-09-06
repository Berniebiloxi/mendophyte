import { run } from "./preflight/run.js";

/**
 * The real diff for the diff/verification panel: working tree versus HEAD
 * (staged and unstaged), the stat, and porcelain status. The UI decides
 * when it may be shown (the "state your fix first" lock); this only
 * reports what git says.
 */
export interface DiffReport {
  ranAt: string;
  repoDir: string;
  branch: string | null;
  head: string | null;
  /** `git status --porcelain=v1` lines. */
  status: { code: string; path: string }[];
  stat: string;
  /** `git diff HEAD` (plus untracked files rendered as additions), possibly truncated. */
  patch: string;
  truncated: boolean;
  filesChanged: number;
  insertions: number;
  deletions: number;
  error?: string;
}

export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export async function readDiff(repoDir: string, opts: { includeUntracked?: boolean; maxBytes?: number } = {}): Promise<DiffReport> {
  const ranAt = new Date().toISOString();
  const g = (...a: string[]) => run("git", a, { cwd: repoDir, timeoutMs: 60_000 });
  const empty: DiffReport = { ranAt, repoDir, branch: null, head: null, status: [], stat: "", patch: "", truncated: false, filesChanged: 0, insertions: 0, deletions: 0 };

  const [branch, head, status, stat, patch] = await Promise.all([
    g("rev-parse", "--abbrev-ref", "HEAD"),
    g("rev-parse", "--short", "HEAD"),
    g("status", "--porcelain=v1", "-z"),
    g("diff", "HEAD", "--stat=120"),
    g("diff", "HEAD"),
  ]);
  if (!status.ok) return { ...empty, error: `git status failed: ${status.error ?? status.stderr.trim()}` };

  const statusEntries: { code: string; path: string }[] = [];
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const code = p.slice(0, 2);
    const file = p.slice(3);
    statusEntries.push({ code, path: file });
    if (code[0] === "R" || code[0] === "C") i++; // rename/copy carries the old path in the next slot
  }

  let patchText = patch.ok ? patch.stdout : "";
  if (opts.includeUntracked !== false) {
    for (const e of statusEntries) {
      if (e.code !== "??") continue;
      const d = await run("git", ["diff", "--no-index", "--", "/dev/null", e.path], { cwd: repoDir, timeoutMs: 30_000 });
      // --no-index exits 1 when files differ, which is the normal case here.
      if (d.stdout) patchText += (patchText.endsWith("\n") || !patchText ? "" : "\n") + d.stdout;
    }
  }
  const maxBytes = opts.maxBytes ?? MAX_PATCH_BYTES;
  const truncated = Buffer.byteLength(patchText) > maxBytes;
  if (truncated) patchText = Buffer.from(patchText).subarray(0, maxBytes).toString("utf8") + "\n… (patch truncated)\n";

  const statText = stat.ok ? stat.stdout : "";
  const summary = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(statText);

  return {
    ...empty,
    branch: branch.ok ? branch.stdout.trim() : null,
    head: head.ok ? head.stdout.trim() : null,
    status: statusEntries,
    stat: statText,
    patch: patchText,
    truncated,
    filesChanged: summary ? Number(summary[1]) : statusEntries.length,
    insertions: summary?.[2] ? Number(summary[2]) : 0,
    deletions: summary?.[3] ? Number(summary[3]) : 0,
  };
}
