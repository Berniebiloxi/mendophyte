import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { computeFragility, formatFragilityFacts, normalizeNumstatPath } from "../src/orchestrator/fragility/index.js";

test("fragility: rename notation normalises to the new path", () => {
  assert.equal(normalizeNumstatPath("src/{old => new}/file.ts"), "src/new/file.ts");
  assert.equal(normalizeNumstatPath("old.ts => new.ts"), "new.ts");
  assert.equal(normalizeNumstatPath("src/{ => lib}/x.ts"), "src/lib/x.ts");
  assert.equal(normalizeNumstatPath("plain/path.ts"), "plain/path.ts");
});

async function buildRepo(): Promise<{ repoDir: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-fragility-"));
  const repoDir = path.join(base, "repo");
  await mkdir(path.join(repoDir, "src", "parser"), { recursive: true });
  await mkdir(path.join(repoDir, "docs"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const commit = (msg: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
  };

  await writeFile(path.join(repoDir, "src", "parser", "lexer.ts"), "export const a = 1;\n// TODO: handle unicode\n");
  await writeFile(path.join(repoDir, "src", "parser", "ast.ts"), "export const b = 1;\n");
  await writeFile(path.join(repoDir, "src", "old-name.ts"), "export const c = 1;\n");
  await writeFile(path.join(repoDir, "docs", "guide.md"), "# guide\n");
  await writeFile(path.join(repoDir, "README.md"), "# fixture\n");
  commit("initial import");

  await appendFile(path.join(repoDir, "src", "parser", "lexer.ts"), "export const a2 = 2; // FIXME wrong\n");
  commit("fix: lexer off-by-one");
  await appendFile(path.join(repoDir, "src", "parser", "lexer.ts"), "export const a3 = 3;\n// TODO: remove\n");
  commit("Fix lexer again (regression)");
  await appendFile(path.join(repoDir, "src", "parser", "lexer.ts"), "export const a4 = 4;\n");
  commit("refactor lexer");
  await appendFile(path.join(repoDir, "src", "parser", "ast.ts"), "export const b2 = 2;\n");
  commit('Revert "ast change"');
  git("mv", "src/old-name.ts", "src/new-name.ts");
  commit("rename module");
  await appendFile(path.join(repoDir, "src", "new-name.ts"), "export const c2 = 2; // HACK\n");
  commit("tweak renamed module");

  return { repoDir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("fragility: churn, fix clustering, markers, renames and stale files from a synthetic history", { timeout: 60_000 }, async () => {
  const { repoDir, cleanup } = await buildRepo();
  try {
    const r = await computeFragility({ repoDir, since: "10 years" });
    assert.equal(r.error, undefined);
    assert.equal(r.window.commitsScanned, 7);
    assert.equal(r.window.fixCommits, 3, "two fix subjects + one revert");
    assert.equal(r.window.revertCommits, 1);
    assert.equal(r.trackedFiles, 5);

    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    const lexer = by["src/parser/lexer.ts"];
    assert.equal(lexer.commits, 4);
    assert.equal(lexer.fixCommits, 2);
    assert.equal(lexer.fixExamples.length, 2);
    assert.match(lexer.fixExamples[0].subject, /Fix lexer again/);
    assert.deepEqual(lexer.markers, { TODO: 2, FIXME: 1, HACK: 0, XXX: 0 });
    assert.equal(lexer.lines, 6);
    assert.ok(lexer.markersPerKloc && lexer.markersPerKloc > 400);
    assert.equal(r.top.churn[0].path, "src/parser/lexer.ts");
    assert.equal(r.top.fixes[0].path, "src/parser/lexer.ts");
    assert.equal(r.top.markers[0].path, "src/parser/lexer.ts");
    assert.equal(r.files[0].path, "src/parser/lexer.ts", "hottest file first");

    assert.equal(by["src/parser/ast.ts"].revertCommits, 1);
    assert.equal(by["src/parser/ast.ts"].fixCommits, 1, "reverts count as fix-like");

    assert.ok(by["src/new-name.ts"], "renamed file reported under its new name");
    assert.equal(by["src/old-name.ts"], undefined, "old name no longer tracked");
    assert.equal(by["src/new-name.ts"].markers.HACK, 1);

    const dirs = Object.fromEntries(r.directories.map((d) => [d.path, d]));
    assert.equal(dirs["src/"].commits, 7);
    assert.equal(dirs["src/parser/"].commits, 5);
    assert.equal(dirs["src/parser/"].files, 2);
    assert.equal(r.fixClusters[0].path === "src/" || r.fixClusters[0].path === "src/parser/", true);
    assert.equal(dirs["src/parser/"].fixCommits, 3);

    assert.deepEqual(r.markerTotals, { TODO: 2, FIXME: 1, HACK: 1, XXX: 0 });
    assert.equal(r.stale.count, 0, "everything was touched inside a 10-year window");

    const text = formatFragilityFacts(r);
    assert.match(text, /### Churn/);
    assert.match(text, /`src\/parser\/lexer.ts`: 4 commits/);
    assert.match(text, /2 fix\/revert commits of 4 \(50%\)/);
    assert.match(text, /"fix: lexer off-by-one"/);
    assert.match(text, /TODO 2, FIXME 1, HACK 1, XXX 0 across 2 files/);
    assert.match(text, /weak signal/i);
    assert.ok(!/heat/i.test(text), "the heat blend is never shown to the agent");

    // Narrowed to a subpath: only that directory's files and commits.
    const sub = await computeFragility({ repoDir, since: "10 years", subpath: "src/parser" });
    assert.equal(sub.subpath, "src/parser");
    assert.equal(sub.trackedFiles, 2);
    assert.equal(sub.window.commitsScanned, 5);
    assert.ok(sub.files.every((f) => f.path.startsWith("src/parser/")));
    assert.match(formatFragilityFacts(sub), /subpath `src\/parser`/);

    // A window that excludes everything: stale count covers all tracked files, no crash.
    const none = await computeFragility({ repoDir, since: "2099-01-01" });
    assert.equal(none.window.commitsScanned, 0);
    assert.equal(none.stale.count, 5);
    assert.match(formatFragilityFacts(none), /no commits in the window/);
  } finally {
    await cleanup();
  }
});

test("fragility: a non-repo reports an error instead of throwing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mendophyte-notrepo-"));
  try {
    const r = await computeFragility({ repoDir: dir });
    assert.ok(r.error);
    assert.match(formatFragilityFacts(r), /UNOBSERVED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
