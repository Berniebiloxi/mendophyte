import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describeProject, guessRepoDir, listProjects, locateProject } from "../src/server/projects.js";

async function gitRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
}

test("projects: recovers the clone path from a snapshot, then a benchmark run, else guesses by name, else needs Locate", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendo-proj-"));
  try {
    const root = path.join(base, "homes");
    const code = path.join(base, "code");
    // a home with a record
    await mkdir(path.join(root, "recorded"), { recursive: true });
    await writeFile(path.join(root, "recorded", "project.json"), JSON.stringify({ repoDir: "/r/recorded", repoUrl: null, model: "sonnet", lastSessionAt: "2026-09-06T00:00:00.000Z" }));
    // a home whose snapshot names the repository
    const snapRepo = path.join(code, "snappy");
    await gitRepo(snapRepo);
    await mkdir(path.join(root, "snappy", "snapshots"), { recursive: true });
    await writeFile(path.join(root, "snappy", "snapshots", "snapshot-1.md"), `# x\n\n- repository: ${snapRepo}\n`);
    // a home whose benchmark run recorded a cwd inside the clone
    const benchRepo = path.join(code, "benchy");
    await gitRepo(benchRepo);
    await mkdir(path.join(benchRepo, "sub"));
    await mkdir(path.join(root, "benchy", "benchmarks"), { recursive: true });
    await writeFile(path.join(root, "benchy", "benchmarks", "run.json"), JSON.stringify({ id: "1", cwd: path.join(benchRepo, "sub") }));
    // a home with nothing, but a same-named clone in a search parent
    const guessRepo = path.join(code, "guessy");
    await gitRepo(guessRepo);
    await mkdir(path.join(root, "guessy"));
    // a home with nothing and no clone anywhere
    await mkdir(path.join(root, "lost"));
    await mkdir(path.join(root, "logs"));

    const list = await listProjects(root, { parents: [code] });
    const by = Object.fromEntries(list.map((p) => [p.name, p]));
    assert.equal("logs" in by, false);
    assert.equal(by.recorded.repoDirSource, "record");
    assert.equal(by.recorded.repoDir, "/r/recorded");
    assert.equal(by.snappy.repoDirSource, "snapshot");
    assert.equal(await realish(by.snappy.repoDir!), await realish(snapRepo));
    assert.equal(by.benchy.repoDirSource, "benchmark");
    assert.equal(await realish(by.benchy.repoDir!), await realish(benchRepo), "benchmark cwd resolves to the git top level");
    assert.equal(by.guessy.repoDirSource, "guess");
    assert.equal(by.guessy.repoDir, guessRepo);
    assert.equal(by.lost.repoDir, null);
    assert.equal(by.lost.repoDirSource, null);

    // recovered-from-files paths were written down; the guess was not
    assert.ok(JSON.parse(await readFile(path.join(root, "snappy", "project.json"), "utf8")).repoDir);
    await assert.rejects(readFile(path.join(root, "guessy", "project.json")));

    // Locate validates and records
    await assert.rejects(locateProject(path.join(root, "lost"), path.join(base, "nowhere")), /not a directory/);
    await assert.rejects(locateProject(path.join(root, "lost"), base), /not inside a git repository/);
    const located = await locateProject(path.join(root, "lost"), path.join(benchRepo, "sub"));
    assert.equal(located.repoDirSource, "record");
    assert.equal(await realish(located.repoDir!), await realish(benchRepo));
    assert.equal(await guessRepoDir("nope", [code]), null);
    assert.equal((await describeProject(path.join(root, "lost"))).repoDirSource, "record");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function realish(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(p).catch(() => p);
}
