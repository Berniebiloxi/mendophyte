import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

/**
 * "Prior projects" are artifact homes under ~/.mendophyte, one per
 * repository. Since 0.2.0 each home records its clone in project.json;
 * homes from before that are recovered from what they already hold
 * (snapshots name the repository, benchmark runs record their cwd) or,
 * failing that, guessed by name in the usual places code lives. A guess
 * is shown as a guess and never written down until a session actually
 * starts there or the user confirms it with Locate.
 */

export interface ProjectRecord {
  repoDir: string | null;
  repoUrl: string | null;
  model: string | null;
  lastSessionAt: string | null;
}

export type RepoDirSource = "record" | "snapshot" | "benchmark" | "guess" | null;

export interface ProjectInfo extends ProjectRecord {
  name: string;
  artifactHome: string;
  modified: string;
  repoDirSource: RepoDirSource;
}

export function projectsRoot(): string {
  return path.join(os.homedir(), ".mendophyte");
}

export async function readRecord(home: string): Promise<ProjectRecord | null> {
  try {
    const j = JSON.parse(await readFile(path.join(home, "project.json"), "utf8"));
    return { repoDir: j.repoDir ?? null, repoUrl: j.repoUrl ?? null, model: j.model ?? null, lastSessionAt: j.lastSessionAt ?? null };
  } catch {
    return null;
  }
}

export async function writeRecord(home: string, rec: ProjectRecord): Promise<void> {
  await writeFile(path.join(home, "project.json"), JSON.stringify(rec, null, 2));
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}

/** The git top level of a path, or null if it is not inside a work tree. */
async function gitTopLevel(p: string): Promise<string | null> {
  if (!(await isDir(p))) return null;
  try {
    const { stdout } = await execFileP("git", ["-C", p, "rev-parse", "--show-toplevel"], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Newest snapshot's "- repository:" line. */
async function fromSnapshots(home: string): Promise<string | null> {
  const dir = path.join(home, "snapshots");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md")).sort().reverse();
  for (const n of names) {
    const txt = await readFile(path.join(dir, n), "utf8").catch(() => "");
    const m = /^- repository: (.+)$/m.exec(txt);
    if (m) return m[1].trim();
  }
  return null;
}

/** Newest benchmark run's cwd, resolved to its git top level. */
async function fromBenchmarks(home: string): Promise<string | null> {
  const dir = path.join(home, "benchmarks");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort().reverse();
  for (const n of names) {
    try {
      const j = JSON.parse(await readFile(path.join(dir, n), "utf8"));
      const cwd = typeof j.cwd === "string" ? j.cwd : typeof j.repoDir === "string" ? j.repoDir : null;
      if (cwd) return (await gitTopLevel(cwd)) ?? cwd;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Where people keep clones; the first `<parent>/<name>` that is a git work tree wins. */
export function defaultSearchParents(home = os.homedir()): string[] {
  const h = (...p: string[]) => path.join(home, ...p);
  return [
    h("Projects"), h("projects"), h("src"), h("code"), h("Code"), h("dev"), h("Developer"), h("repos"), h("git"), h("work"), h("workspace"),
    h("Documents", "GitHub"), h("Documents"), h("Desktop"), h(),
  ];
}

export async function guessRepoDir(name: string, parents = defaultSearchParents()): Promise<string | null> {
  for (const parent of parents) {
    const candidate = path.join(parent, name);
    if (await isDir(path.join(candidate, ".git"))) return candidate;
  }
  return null;
}

/** Full description of one artifact home, recovering the clone path when there is no record. */
export async function describeProject(home: string, opts: { parents?: string[]; persist?: boolean } = {}): Promise<ProjectInfo> {
  const name = path.basename(home);
  const st = await stat(home);
  const base: ProjectInfo = { name, artifactHome: home, modified: st.mtime.toISOString(), repoDir: null, repoUrl: null, model: null, lastSessionAt: null, repoDirSource: null };
  const rec = await readRecord(home);
  if (rec?.repoDir) return { ...base, ...rec, repoDirSource: "record" };

  let repoDir = await fromSnapshots(home);
  let source: RepoDirSource = repoDir ? "snapshot" : null;
  if (!repoDir) {
    repoDir = await fromBenchmarks(home);
    if (repoDir) source = "benchmark";
  }
  if (repoDir && !(await isDir(repoDir))) {
    repoDir = null;
    source = null;
  }
  if (repoDir && opts.persist !== false) {
    // Recovered from the home's own files: certain enough to write down.
    await writeRecord(home, { ...(rec ?? { repoUrl: null, model: null, lastSessionAt: null }), repoDir }).catch(() => {});
  }
  if (!repoDir) {
    repoDir = await guessRepoDir(name, opts.parents);
    if (repoDir) source = "guess";
  }
  return { ...base, ...(rec ?? {}), repoDir, repoDirSource: source };
}

export async function listProjects(root = projectsRoot(), opts: { parents?: string[] } = {}): Promise<ProjectInfo[]> {
  const out: ProjectInfo[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name === "logs" || name.startsWith(".")) continue;
    const p = path.join(root, name);
    if (!(await isDir(p))) continue;
    out.push(await describeProject(p, opts));
  }
  out.sort((a, b) => (b.lastSessionAt ?? b.modified).localeCompare(a.lastSessionAt ?? a.modified));
  return out;
}

/** The user tells us where the clone is. Must be a directory inside a git work tree. */
export async function locateProject(home: string, repoDir: string): Promise<ProjectInfo> {
  const abs = path.resolve(repoDir);
  if (!(await isDir(abs))) throw new Error(`${abs} is not a directory`);
  const top = await gitTopLevel(abs);
  if (!top) throw new Error(`${abs} is not inside a git repository`);
  const rec = (await readRecord(home)) ?? { repoUrl: null, model: null, lastSessionAt: null, repoDir: null };
  await writeRecord(home, { ...rec, repoDir: top });
  return describeProject(home);
}
