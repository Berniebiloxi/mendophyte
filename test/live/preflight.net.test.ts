/**
 * Network integration for the pre-flight probes: points a throwaway repo
 * at a real public GitHub project and checks the forge-side facts come
 * back OBSERVED. No model call, but needs the network (and `gh` for the
 * full tier). Runs with `npm run test:live`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { formatPreflightFacts, runPreflight } from "../../src/orchestrator/preflight/index.js";

const LIVE = process.env.MENDOPHYTE_LIVE === "1";
const TARGET = "https://github.com/anthropics/claude-agent-sdk-typescript.git";

test("preflight (network): public GitHub repo is observed via ls-remote and the API", { skip: !LIVE, timeout: 120_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-preflight-net-"));
  const repoDir = path.join(base, "repo");
  try {
    await mkdir(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["remote", "add", "origin", TARGET], { cwd: repoDir });

    const r = await runPreflight({ repoDir, artifactHome: path.join(base, "artifacts") });

    assert.equal(r.capability.forge?.kind, "github");
    assert.equal(r.capability.forge?.path, "anthropics/claude-agent-sdk-typescript");
    assert.equal(r.capability.lsRemote.ok, true, r.capability.lsRemote.summary);
    assert.ok((r.capability.lsRemote.refCount ?? 0) > 0);
    assert.equal(r.capability.anonymousApi.ok, true, r.capability.anonymousApi.summary);
    assert.equal(r.capability.anonymousApi.status, 200);
    assert.ok(r.capability.tier === "full" || r.capability.tier === "partial");

    assert.equal(r.health.observed, true);
    assert.equal(r.health.exists, true);
    assert.equal(r.health.public, true);
    assert.equal(r.health.archived, false);
    assert.ok(r.health.defaultBranch);

    const text = formatPreflightFacts(r);
    assert.ok(text.includes("OBSERVED (`GET https://api.github.com/repos/anthropics/claude-agent-sdk-typescript`)"));
    assert.ok(!/Capability tier: local clone only/.test(text));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
