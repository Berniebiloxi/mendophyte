import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGuardrail, commandFromToolInput } from "../src/orchestrator/guardrails.js";

const id = (cmd: string) => matchGuardrail(cmd)?.ruleId ?? null;

test("guardrail: commits", () => {
  assert.equal(id("git commit -m 'fix'"), "git-commit");
  assert.equal(id("git -C /tmp/x commit -am wip"), "git-commit");
  assert.equal(id("npm test && git commit -m ok"), "git-commit");
  assert.equal(id("git commit --amend --no-edit"), "git-history-rewrite");
});

test("guardrail: pushes and force pushes", () => {
  assert.equal(id("git push"), "git-push");
  assert.equal(id("git push origin feature"), "git-push");
  assert.equal(id("git push --force"), "git-force-push");
  assert.equal(id("git push -f origin main"), "git-force-push");
  assert.equal(id("git push --force-with-lease"), "git-force-push");
  assert.equal(id("git push origin +feature"), "git-force-push");
});

test("guardrail: history rewrites and hard resets", () => {
  assert.equal(id("git rebase -i HEAD~3"), "git-history-rewrite");
  assert.equal(id("git filter-branch --all"), "git-history-rewrite");
  assert.equal(id("git reset --hard HEAD~1"), "git-reset-hard");
  assert.equal(id("git reset --hard"), "git-reset-hard");
});

test("guardrail: recursive deletes", () => {
  assert.equal(id("rm -rf node_modules"), "recursive-delete");
  assert.equal(id("rm -r build"), "recursive-delete");
  assert.equal(id("rm -fR ./dist"), "recursive-delete");
  assert.equal(id("rm --recursive tmp"), "recursive-delete");
  assert.equal(id("cd x && rm -rf ."), "recursive-delete");
  assert.equal(id("Remove-Item -Recurse -Force build"), "recursive-delete");
});

test("guardrail: opening a PR", () => {
  assert.equal(id("gh pr create --fill"), "open-pull-request");
  assert.equal(id("glab mr create"), "open-pull-request");
});

test("guardrail: ordinary commands are not matched", () => {
  for (const c of [
    "git status",
    "git log --oneline -20",
    "git diff",
    "git add -A",
    "git checkout -b fix/thing",
    "git fetch origin",
    "git stash",
    "git reset HEAD file.txt",
    "git reset --soft HEAD~1",
    "rm file.txt",
    "rm -f file.txt",
    "npm test",
    "cargo bench",
    "grep -r commit src/",
    "gh pr view 12",
    "gh pr list",
    "git commit-tree",
  ]) {
    assert.equal(id(c), null, `expected no match for: ${c}`);
  }
});

test("guardrail: matching is deliberately conservative (no shell parsing)", () => {
  // A guardrail word inside a quoted string still prompts. The modal shows
  // the exact command, so a false "confirm?" costs one click; a miss on
  // `sh -c 'git push'` would cost an unconfirmed push.
  assert.equal(id("echo 'do not git push yet' > notes.txt"), "git-push");
  assert.equal(id("sh -c 'git push origin main'"), "git-push");
  assert.equal(id("rmdir /s /q build"), "recursive-delete");
});

test("guardrail: extracts command from tool input", () => {
  assert.equal(commandFromToolInput({ command: "git push" }), "git push");
  assert.equal(commandFromToolInput({}), "");
  assert.equal(commandFromToolInput(null), "");
});
