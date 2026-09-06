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

test("guardrail: forge writes beyond PR creation need confirmation; reads stay free", () => {
  assert.equal(id("gh issue create --title x --body y"), "forge-write");
  assert.equal(id("cd /r && gh issue create -F body.md"), "forge-write");
  assert.equal(id("gh issue comment 40235 --body ok"), "forge-write");
  assert.equal(id("gh pr comment 12 --body lgtm"), "forge-write");
  assert.equal(id("gh pr review 12 --approve"), "forge-write");
  assert.equal(id("gh pr merge 12 --squash"), "forge-write");
  assert.equal(id("gh repo fork langchain-ai/langchain --remote"), "forge-write");
  assert.equal(id("gh release create v1.0"), "forge-write");
  assert.equal(id("gh api -X POST repos/o/r/issues -f title=x"), "forge-write");
  assert.equal(id("gh api repos/o/r/issues --method PATCH -f state=closed"), "forge-write");
  assert.equal(id("gh api repos/o/r/issues -f title=x"), "forge-write");
  assert.equal(id("gh api graphql -F query=@q.graphql"), "forge-write");
  assert.equal(id("glab issue create -t x"), "forge-write");
  assert.equal(id("glab mr note 3 -m hi"), "forge-write");
  // PR creation keeps its sharper rule
  assert.equal(id("gh pr create --fill"), "open-pull-request");
  // reads
  assert.equal(id("gh issue list --repo o/r --state open"), null);
  assert.equal(id("gh issue view 40235 --comments"), null);
  assert.equal(id("gh pr list --search 'import'"), null);
  assert.equal(id("gh pr view 12 --json statusCheckRollup"), null);
  assert.equal(id("gh pr checkout 12"), null);
  assert.equal(id("gh pr diff 12"), null);
  assert.equal(id("gh api repos/o/r/pulls/12"), null);
  assert.equal(id("gh api repos/o/r/issues?state=open --paginate"), null);
  assert.equal(id("gh api -X GET repos/o/r"), null);
  assert.equal(id("gh auth status"), null);
  assert.equal(id("gh search issues --repo o/r 'import time'"), null);
  assert.equal(id("gh repo view o/r --json isArchived"), null);
  assert.equal(id("gh repo clone o/r"), null);
  assert.equal(id("gh run list"), null);
  assert.equal(id("glab issue list"), null);
  assert.equal(id("glab mr view 3"), null);
});

test("guardrail: git stash push is local, not a push", () => {
  assert.equal(id("git stash push -- src/filters.ts"), null);
  assert.equal(id("export PATH=x && git stash push -m wip >/dev/null && git stash pop"), null);
  assert.equal(id("git stash && git push"), "git-push");
  assert.equal(id("git push --force"), "git-force-push");
});
