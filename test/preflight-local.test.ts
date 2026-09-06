import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { formatPreflightFacts, runPreflight } from "../src/orchestrator/preflight/index.js";

test("preflight: a remote-less local repo is classified local-only with everything forge-side unobserved", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-preflight-"));
  const repoDir = path.join(base, "repo");
  const artifactHome = path.join(base, "artifacts");
  try {
    await mkdir(repoDir);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await mkdir(path.join(repoDir, "src"));
    await writeFile(path.join(repoDir, "src", "a.rs"), "fn main() {}\n");
    await writeFile(path.join(repoDir, "src", "b.rs"), "fn x() {}\n");
    await writeFile(path.join(repoDir, "README.md"), "# fixture\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    await writeFile(path.join(repoDir, "scratch.txt"), "dirty\n");

    const r = await runPreflight({ repoDir, artifactHome });

    assert.equal(r.capability.forge, null);
    assert.equal(r.capability.tier, "local-only");
    assert.equal(r.capability.lsRemote.ok, false);
    assert.equal(r.capability.anonymousApi.skipped, true);
    assert.equal(r.health.observed, false);

    assert.equal(r.git.isRepo, true);
    assert.equal(r.git.branch, "main");
    assert.equal(r.git.upstream, null);
    assert.equal(r.git.dirtyFiles, 1);

    assert.equal(r.scale.trackedFiles, 3);
    assert.deepEqual(r.scale.topExtensions[0], [".rs", 2]);
    assert.deepEqual(r.scale.topDirectories[0], ["src/", 2]);

    assert.equal(r.artifacts.exists, false);
    assert.equal(r.policy.files.length, 0);
    assert.ok(r.environment.cpuCount >= 1);

    const text = formatPreflightFacts(r);
    assert.ok(text.includes("Capability tier: local clone only"));
    assert.ok(text.includes("UNOBSERVED"));
    assert.ok(text.includes("no origin remote"));
    assert.ok(text.includes("3 tracked files"));
    assert.ok(text.includes("does not exist yet"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("preflight: an explicit repo URL stands in for a missing origin, and existing artifacts are listed", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-preflight-"));
  const repoDir = path.join(base, "repo");
  const artifactHome = path.join(base, "artifacts");
  try {
    await mkdir(repoDir);
    await mkdir(artifactHome);
    await writeFile(path.join(artifactHome, "A-recon-notes.md"), "# notes\n");
    execFileSync("git", ["init", "-q"], { cwd: repoDir });

    // Unknown forge host: parsed, but no API probe exists for it, and the
    // remote itself is not reachable, so this stays deterministic offline.
    const r = await runPreflight({ repoDir, artifactHome, repoUrl: "https://git.invalid.example/team/proj.git" });
    assert.equal(r.capability.forge?.kind, "unknown");
    assert.equal(r.capability.anonymousApi.skipped, true);
    assert.equal(r.capability.authCli.skipped, true);
    assert.equal(r.artifacts.entries.map((e) => e.name)[0], "A-recon-notes.md");

    const text = formatPreflightFacts(r);
    assert.ok(text.includes("A-recon-notes.md"));
    assert.ok(text.includes("not a forge Mendophyte knows how to probe"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
