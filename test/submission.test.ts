import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { checkCompliance, computeSubmission, formatSubmission, overallStatus, parseTemplate } from "../src/orchestrator/submission.js";

const TEMPLATE = [
  "<!-- Thanks for contributing! -->",
  "## Summary",
  "",
  "## Test plan",
  "",
  "```",
  "## not a heading (in code)",
  "- [ ] not a box",
  "```",
  "## Checklist",
  "- [ ] I have added tests",
  "- [ ] I have updated the **docs**",
  "- [ ] I have run `make lint`",
].join("\n");

test("submission: template parsing skips code blocks and comments", () => {
  const items = parseTemplate(TEMPLATE);
  assert.deepEqual(
    items.map((i) => `${i.kind}:${i.text}`),
    ["heading:Summary", "heading:Test plan", "heading:Checklist", "checkbox:I have added tests", "checkbox:I have updated the **docs**", "checkbox:I have run `make lint`"]
  );
});

test("submission: compliance matches headings and checkboxes, tolerates formatting", () => {
  const body = ["## Summary", "Fixes the lexer.", "", "## checklist", "- [x] I have added tests", "- [ ] I have updated the docs", "- [X] I have run make lint and more"].join("\n");
  const items = checkCompliance(TEMPLATE, body);
  const by = Object.fromEntries(items.map((i) => [i.text, i]));
  assert.equal(by["Summary"].present, true);
  assert.equal(by["Test plan"].present, false, "missing heading is reported");
  assert.equal(by["Checklist"].present, true, "heading match is case-insensitive");
  assert.equal(by["I have added tests"].checked, true);
  assert.equal(by["I have updated the **docs**"].present, true, "markdown emphasis ignored");
  assert.equal(by["I have updated the **docs**"].checked, false);
  assert.equal(by["I have run `make lint`"].checked, true, "prefix match tolerates trailing words");
});

test("submission: overall CI status precedence", () => {
  const c = (status: any) => ({ name: "x", status, url: null, startedAt: null, completedAt: null, kind: "check-run" as const });
  assert.equal(overallStatus([]), null);
  assert.equal(overallStatus([c("success"), c("success")]), "success");
  assert.equal(overallStatus([c("success"), c("pending")]), "pending");
  assert.equal(overallStatus([c("failure"), c("pending")]), "failure");
  assert.equal(overallStatus([c("skipped"), c("neutral")]), "neutral");
});

test("submission: local repo with a bare remote — unobserved forge, DCO and sync facts from git", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-sub-"));
  const bare = path.join(base, "remote.git");
  const repoDir = path.join(base, "repo");
  const artifactHome = path.join(base, "art");
  await mkdir(artifactHome);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "-q", bare, repoDir]);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await mkdir(path.join(repoDir, ".github"));
  await writeFile(path.join(repoDir, ".github", "PULL_REQUEST_TEMPLATE.md"), TEMPLATE);
  await writeFile(path.join(repoDir, "CONTRIBUTING.md"), "# Contributing\n\nAll commits must be signed off (DCO): use `git commit -s`.\n");
  await writeFile(path.join(repoDir, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("push", "-q", "-u", "origin", "main");
  git("checkout", "-q", "-b", "fix/thing");
  await writeFile(path.join(repoDir, "README.md"), "# fixture\nfixed\n");
  git("commit", "-q", "-am", "fix: thing");
  await writeFile(path.join(repoDir, "README.md"), "# fixture\nfixed twice\n");
  git("commit", "-q", "-s", "-am", "fix: thing again");
  git("push", "-q", "-u", "origin", "fix/thing");
  // one more local commit, unpushed
  await writeFile(path.join(repoDir, "README.md"), "# fixture\nthrice\n");
  git("commit", "-q", "-am", "wip");
  // main moves ahead on the remote (simulate upstream activity)
  const other = path.join(base, "other");
  execFileSync("git", ["clone", "-q", bare, other]);
  execFileSync("git", ["-c", "user.email=o@example.com", "-c", "user.name=o", "commit", "-q", "--allow-empty", "-m", "upstream moved"], { cwd: other });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other });

  // Artifact E draft in the artifact home
  await writeFile(path.join(artifactHome, "E-submission.md"), "## Summary\nfix thing\n\n## Test plan\nran tests\n\n## Checklist\n- [x] I have added tests\n- [ ] I have updated the docs\n");

  try {
    const r = await computeSubmission({ repoDir, artifactHome, fetch: true });
    assert.equal(r.branch, "fix/thing");
    assert.equal(r.forge?.kind, undefined, "a file path remote is not a forge");
    assert.equal(r.pr, null);
    assert.equal(r.prObserved, false);
    assert.match(r.prReason ?? "", /no origin remote|not a forge|no PR/i);
    assert.equal(r.ci.observed, false);

    assert.equal(r.template.templatePath, ".github/PULL_REQUEST_TEMPLATE.md");
    assert.equal(r.template.draftSource, "artifact");
    assert.equal(r.template.missing, 1, "the `make lint` checkbox is absent from the draft");
    assert.equal(r.template.unchecked, 1);

    assert.equal(r.legal.dcoRequired, true);
    assert.match(r.legal.evidence ?? "", /CONTRIBUTING\.md/);
    assert.equal(r.legal.commitsChecked, 1, "commits ahead of upstream: only the unpushed wip");
    assert.equal(r.legal.signedOff, 0);

    assert.equal(r.sync.upstream, "origin/fix/thing");
    assert.equal(r.sync.unpushed, 1);
    assert.equal(r.sync.baseRemote, "origin");
    assert.equal(r.sync.baseBranch, "main");
    assert.equal(r.sync.fetched, true);
    assert.equal(r.sync.aheadOfBase, 3);
    assert.equal(r.sync.behindBase, 1, "upstream moved after fetch");

    const text = formatSubmission(r);
    assert.match(text, /UNOBSERVED/);
    assert.match(text, /MISSING checkbox: I have run `make lint`/);
    assert.match(text, /DCO\/sign-off required: yes/);
    assert.match(text, /behind 1 \(after fetch\)/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
