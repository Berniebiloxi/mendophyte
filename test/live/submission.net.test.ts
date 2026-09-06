/**
 * Network: submission facts against a real public GitHub repository clone.
 * `gh` (if authenticated) or the anonymous API must report "no PR" for the
 * default branch as an observation, and CI for HEAD must be observed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { computeSubmission, formatSubmission } from "../../src/orchestrator/submission.js";

const LIVE = process.env.MENDOPHYTE_LIVE === "1";
const TARGET = "https://github.com/anthropics/claude-agent-sdk-typescript.git";

test("submission (network): default branch of a public repo — PR absence and CI observed", { skip: !LIVE, timeout: 180_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-sub-net-"));
  const repoDir = path.join(base, "repo");
  const artifactHome = path.join(base, "art");
  await mkdir(artifactHome);
  execFileSync("git", ["clone", "-q", "--depth", "5", TARGET, repoDir]);
  try {
    const r = await computeSubmission({ repoDir, artifactHome, fetch: true });
    assert.equal(r.baseRepo?.kind, "github");
    assert.equal(r.branch, "main");
    assert.equal(r.pr, null);
    assert.equal(r.prObserved, true, `PR absence should be an observation: ${r.prReason}`);
    assert.match(r.prReason ?? "", /no pull request/i);
    assert.equal(r.ci.observed, true, r.ci.reason ?? "");
    assert.equal(r.ci.sha, r.head);
    assert.equal(r.sync.fetched, true);
    assert.equal(r.sync.baseBranch, "main");
    assert.equal(r.sync.aheadOfBase, 0);
    const text = formatSubmission(r);
    assert.match(text, /### CI\n- OBSERVED/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
