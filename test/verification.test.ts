import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { defaultCheckSet, detectVerification, extractCiRunSteps, formatDetection, formatRun, runVerification } from "../src/orchestrator/verification/index.js";
import { readDiff } from "../src/orchestrator/git-diff.js";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "mendophyte-verify-"));

test("verification: detects node scripts, cargo, go, python, make, pre-commit, pins and CI steps", { timeout: 60_000 }, async () => {
  const root = await tmp();
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", engines: { node: ">=20" }, scripts: { test: "vitest run", lint: "eslint .", "lint:fix": "eslint . --fix", format: "prettier --write .", "format:check": "prettier --check .", typecheck: "tsc --noEmit", build: "tsc", dev: "vite" } })
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await writeFile(path.join(root, ".nvmrc"), "20.11.0\n");
    await writeFile(path.join(root, "Cargo.toml"), "[package]\nname = \"x\"\n");
    await writeFile(path.join(root, "rust-toolchain.toml"), "[toolchain]\nchannel = \"1.80.0\"\n");
    await writeFile(path.join(root, "go.mod"), "module example.com/x\n\ngo 1.22\n");
    await writeFile(path.join(root, "pyproject.toml"), '[project]\nrequires-python = ">=3.11"\n[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[tool.mypy]\nstrict = true\n');
    await writeFile(path.join(root, "tox.ini"), "[tox]\nenvlist = py311\n");
    await writeFile(path.join(root, "Makefile"), "all: build\n\nbuild:\n\tgo build\n\ntest:\n\tgo test ./...\n\nlint:\n\tgolangci-lint run\n\nfmt:\n\tgofmt -w .\n\n.PHONY: all\n\nCC := gcc\n");
    await writeFile(path.join(root, ".pre-commit-config.yaml"), "repos: []\n");
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github", "workflows", "ci.yml"),
      ["name: CI", "on: [push]", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - uses: actions/checkout@v4", "      - run: pnpm install --frozen-lockfile", "      - name: Test", "        run: |", "          pnpm lint", "          pnpm test", "      - run: 'cargo test --all'"].join("\n")
    );
    await writeFile(path.join(root, ".gitlab-ci.yml"), "test:\n  script:\n    - pip install -e .\n    - pytest\n");

    const d = await detectVerification(root);
    const ids = d.checks.map((c) => c.id);
    for (const want of ["pnpm:test", "pnpm:lint", "pnpm:format", "pnpm:format:check", "pnpm:typecheck", "pnpm:build", "cargo:fmt-check", "cargo:clippy", "cargo:test", "go:gofmt", "go:vet", "go:test", "py:pytest", "py:ruff-check", "py:ruff-format-check", "py:mypy", "py:tox", "make:test", "make:lint", "make:fmt", "make:build", "pre-commit:all"]) {
      assert.ok(ids.includes(want), `missing ${want} in ${ids.join(", ")}`);
    }
    assert.ok(!ids.includes("pnpm:dev"));
    const byId = Object.fromEntries(d.checks.map((c) => [c.id, c]));
    assert.equal(byId["pnpm:test"].command, "pnpm run test");
    assert.equal(byId["pnpm:test"].kind, "test");
    assert.equal(byId["pnpm:format"].mayModify, true, "prettier --write modifies files");
    assert.equal(byId["pnpm:format:check"].mayModify, undefined);
    assert.equal(byId["pnpm:lint:fix"]?.mayModify ?? byId["pnpm:lint:fix"], undefined, "lint:fix is not classified as a check");
    assert.equal(byId["go:gofmt"].successRule, "no-output");
    assert.equal(byId["py:tox"].heavy, true);
    assert.equal(byId["make:fmt"].mayModify, true);
    assert.match(byId["pnpm:test"].source, /package\.json scripts\.test = "vitest run"/);

    const def = defaultCheckSet(d).map((c) => c.id);
    assert.ok(def.includes("pnpm:test") && def.includes("cargo:clippy") && def.includes("go:gofmt") && def.includes("py:mypy"));
    assert.ok(!def.includes("pnpm:format"), "mutating formatters excluded from default set");
    assert.ok(!def.includes("pnpm:build") && !def.includes("py:tox") && !def.includes("pre-commit:all"));
    assert.deepEqual(defaultCheckSet(d, ["build"]).map((c) => c.id).sort(), ["cargo:build", "go:build", "make:all", "make:build", "pnpm:build"]);

    const pins = Object.fromEntries(d.toolchain.map((t) => [`${t.tool}:${t.source}`, t]));
    assert.equal(pins["node:package.json engines.node"].pinned, ">=20");
    assert.equal(pins["node:.nvmrc / .node-version"].pinned, "20.11.0");
    assert.match(pins["node:.nvmrc / .node-version"].local ?? "", /^v\d+/);
    assert.equal(pins["rust:rust-toolchain(.toml)"].pinned, "1.80.0");
    assert.equal(pins["go:go.mod go directive"].pinned, "1.22");
    assert.equal(pins["python:pyproject.toml requires-python"].pinned, ">=3.11");

    const runs = d.ciSteps.map((s) => s.run);
    assert.ok(runs.includes("pnpm install --frozen-lockfile"));
    assert.ok(runs.includes("pnpm lint\npnpm test"), `block scalar not captured: ${JSON.stringify(runs)}`);
    assert.ok(runs.includes("cargo test --all"));
    assert.ok(runs.includes("pip install -e .\npytest"), `gitlab script list not captured: ${JSON.stringify(runs)}`);

    const text = formatDetection(d);
    assert.match(text, /Candidate checks/);
    assert.match(text, /`pnpm:test` \(test\): `pnpm run test`/);
    assert.match(text, /rust: pinned `1.80.0`/);
    assert.match(text, /\.github\/workflows\/ci\.yml: `pnpm lint` \(\+1 more line\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification: CI step extraction handles inline, block, quoted and gitlab forms", () => {
  const steps = extractCiRunSteps("w.yml", ["steps:", "  - run: npm ci", "  - run: >", "      npm test --", "      --coverage", "  - name: x", "    run: \"make check\"", "  - uses: a/b"].join("\n"));
  assert.deepEqual(steps.map((s) => s.run), ["npm ci", "npm test --\n--coverage", "make check"]);
});

test("verification: no manifest yields a note and an empty default set", async () => {
  const root = await tmp();
  try {
    const d = await detectVerification(root);
    assert.equal(d.checks.length, 0);
    assert.match(d.notes[0], /No recognised manifest/);
    assert.deepEqual(defaultCheckSet(d), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification: runs commands and reports real outcomes, refuses guardrail commands and escapes, writes logs", { timeout: 60_000 }, async () => {
  const root = await tmp();
  const repoDir = path.join(root, "repo");
  const artifactHome = path.join(root, "artifacts");
  await mkdir(path.join(repoDir, "sub"), { recursive: true });
  try {
    const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
    const progress: string[] = [];
    const run = await runVerification({
      repoDir,
      artifactHome,
      timeoutMs: 3_000,
      onProgress: (p) => progress.push(p.phase === "start" ? `start ${p.check.id}` : `finish ${p.result.id} ${p.result.status}`),
      checks: [
        { id: "ok", kind: "test", command: `${node} -e "console.log('fine')"`, source: "t" },
        { id: "bad", kind: "lint", command: `${node} -e "console.error('boom'); process.exit(3)"`, source: "t" },
        { id: "quiet-ok", kind: "format", command: `${node} -e ""`, source: "t", successRule: "no-output" },
        { id: "quiet-bad", kind: "format", command: `${node} -e "console.log('main.go')"`, source: "t", successRule: "no-output" },
        { id: "slow", kind: "test", command: `${node} -e "setTimeout(()=>{}, 30000)"`, source: "t" },
        { id: "commit", kind: "other", command: "git commit -am sneaky", source: "t" },
        { id: "escape", kind: "other", command: `${node} -e ""`, cwd: "../", source: "t" },
        { id: "in-sub", kind: "other", command: `${node} -e "console.log(process.cwd())"`, cwd: "sub", source: "t" },
        { id: "missing", kind: "other", command: "definitely-not-a-real-command-xyz --version", source: "t" },
      ],
    });

    const by = Object.fromEntries(run.results.map((r) => [r.id, r]));
    assert.equal(by.ok.status, "passed");
    assert.equal(by.ok.exitCode, 0);
    assert.match(by.ok.outputTail, /fine/);
    assert.equal(by.bad.status, "failed");
    assert.equal(by.bad.exitCode, 3);
    assert.match(by.bad.outputTail, /boom/);
    assert.equal(by["quiet-ok"].status, "passed");
    assert.equal(by["quiet-bad"].status, "failed");
    assert.match(by["quiet-bad"].reason ?? "", /no-output rule/);
    assert.equal(by.slow.status, "timeout");
    assert.ok(by.slow.durationMs >= 2_500 && by.slow.durationMs < 20_000);
    assert.equal(by.commit.status, "refused");
    assert.match(by.commit.reason ?? "", /guardrail git-commit/);
    assert.equal(by.escape.status, "refused");
    assert.match(by.escape.reason ?? "", /outside the repository/);
    assert.equal(by["in-sub"].status, "passed");
    assert.match(by["in-sub"].outputTail, /[\\/]sub\s*$/);
    assert.equal(by.missing.status, "failed", "shell reports a missing command as a non-zero exit");
    assert.ok(by.missing.exitCode !== 0);

    assert.equal(run.allPassed, false);
    assert.deepEqual(run.counts, { passed: 3, failed: 3, timeout: 1, refused: 2, error: 0 });

    // logs
    const logsRoot = path.join(artifactHome, "logs");
    const dirs = await readdir(logsRoot);
    assert.equal(dirs.length, 1);
    assert.ok(by.ok.logPath && by.ok.logPath.startsWith(path.join(logsRoot, dirs[0])));
    const log = await readFile(by.bad.logPath!, "utf8");
    assert.match(log, /^\$ .*process\.exit\(3\)/);
    assert.match(log, /boom/);
    assert.match(log, /\[exit 3, \d+ ms\]/);
    assert.equal(by.commit.logPath, null, "refused checks write no log");

    // progress
    assert.equal(progress[0], "start ok");
    assert.equal(progress[1], "finish ok passed");
    assert.equal(progress.length, 18);

    // format: only run checks appear; failing tails shown; refused reasons shown
    const text = formatRun(run);
    assert.match(text, /NOT ALL PASSED\. 3 passed, 3 failed, 1 timed out, 2 refused, 0 errored, of 9 checks/);
    assert.match(text, /- PASS `ok`/);
    assert.match(text, /- FAIL `bad` \(lint\): .*exit 3/);
    assert.match(text, /boom/);
    assert.match(text, /- TIMEOUT `slow`/);
    assert.match(text, /- REFUSED `commit`.*guardrail git-commit/);
    assert.match(text, /only a PASS line here counts as verified/);

    // fail-fast stops after the first non-pass
    const ff = await runVerification({ repoDir, checks: [{ id: "a", kind: "test", command: `${node} -e "process.exit(1)"`, source: "t" }, { id: "b", kind: "test", command: `${node} -e ""`, source: "t" }], failFast: true });
    assert.equal(ff.results.length, 1);
    assert.equal(ff.results[0].logPath, null, "no artifact home, no log file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git-diff: reports staged, unstaged and untracked changes against HEAD", { timeout: 60_000 }, async () => {
  const root = await tmp();
  const repoDir = path.join(root, "repo");
  await mkdir(repoDir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeFile(path.join(repoDir, "a.txt"), "one\ntwo\n");
    await writeFile(path.join(repoDir, "b.txt"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");

    const clean = await readDiff(repoDir);
    assert.equal(clean.error, undefined);
    assert.equal(clean.status.length, 0);
    assert.equal(clean.patch, "");
    assert.equal(clean.filesChanged, 0);

    await writeFile(path.join(repoDir, "a.txt"), "one\nTWO\nthree\n"); // unstaged
    await writeFile(path.join(repoDir, "b.txt"), "B\n");
    git("add", "b.txt"); // staged
    await writeFile(path.join(repoDir, "new.txt"), "brand new\n"); // untracked

    const d = await readDiff(repoDir);
    assert.equal(d.branch, "main");
    assert.deepEqual(d.status.map((s) => `${s.code} ${s.path}`).sort(), [" M a.txt", "?? new.txt", "M  b.txt"]);
    assert.equal(d.filesChanged, 2, "stat covers tracked changes vs HEAD");
    assert.equal(d.insertions, 3);
    assert.equal(d.deletions, 2);
    assert.match(d.patch, /^diff --git a\/a\.txt b\/a\.txt/m);
    assert.match(d.patch, /\+TWO/);
    assert.match(d.patch, /\+B$/m);
    assert.match(d.patch, /\+brand new/, "untracked file rendered as an addition");
    assert.equal(d.truncated, false);

    const noUntracked = await readDiff(repoDir, { includeUntracked: false });
    assert.ok(!/brand new/.test(noUntracked.patch));

    const notRepo = await readDiff(root);
    assert.ok(notRepo.error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
