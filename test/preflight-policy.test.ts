import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { findHits, scanPolicyFiles } from "../src/orchestrator/preflight/policy.js";

test("policy: hit detection is word-bounded and case-aware", () => {
  const { ai, legal } = findHits(
    [
      "We maintain a friendly community.",              // "ai" inside a word: no hit
      "AI-generated patches must be disclosed.",         // AI hit
      "Please do not submit code written with ChatGPT.", // AI hit (case-insensitive word)
      "Sign your commits with a DCO sign-off.",          // legal hit
      "All contributors sign the Contributor License Agreement.", // legal hit
      "The claim is straightforward.",                   // "cla" inside a word: no hit
      "Details are in docs/design.md.",
    ].join("\n")
  );
  assert.deepEqual(ai.map((h) => h.line), [2, 3]);
  assert.deepEqual(legal.map((h) => h.line), [4, 5]);
});

test("policy: finds candidate files case-insensitively, including template and rules directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mendophyte-policy-"));
  try {
    await mkdir(path.join(root, ".github", "PULL_REQUEST_TEMPLATE"), { recursive: true });
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await mkdir(path.join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(root, "contributing.md"), "# Contributing\n\nNo AI-generated code, please.\nSign-off required (DCO).\n");
    await writeFile(path.join(root, ".github", "PULL_REQUEST_TEMPLATE", "bugfix.md"), "## Checklist\n- [ ] I disclose any LLM assistance\n");
    await writeFile(path.join(root, ".github", "workflows", "cla.yml"), "uses: contributor-assistant/github-action@v2\n");
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "runs-on: ubuntu-latest\n");
    await writeFile(path.join(root, "AGENTS.md"), "Run `make test` before committing.\n");
    await writeFile(path.join(root, ".cursor", "rules", "style.mdc"), "Prefer tabs.\n");

    const r = await scanPolicyFiles(root);
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));

    assert.ok(byPath["contributing.md"], "lowercase CONTRIBUTING found");
    assert.equal(byPath["contributing.md"].role, "contributing");
    assert.equal(byPath["contributing.md"].aiHits.length, 1);
    assert.equal(byPath["contributing.md"].legalHits.length, 1);

    assert.equal(byPath[".github/PULL_REQUEST_TEMPLATE/bugfix.md"]?.role, "pr-template");
    assert.equal(byPath[".github/PULL_REQUEST_TEMPLATE/bugfix.md"]?.aiHits.length, 1);

    assert.equal(byPath[".github/workflows/cla.yml"]?.role, "workflow");
    assert.equal(byPath[".github/workflows/cla.yml"]?.legalHits.length, 1);
    assert.ok(!byPath[".github/workflows/ci.yml"], "unrelated workflows are not scanned");

    assert.equal(byPath["AGENTS.md"]?.role, "agent-instructions");
    assert.equal(byPath["AGENTS.md"]?.aiHits.length, 0, "an agent file with no AI words is still reported, with zero hits");
    assert.equal(byPath[".cursor/rules/style.mdc"]?.role, "agent-instructions");

    assert.ok(r.checked.includes("CLAUDE.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
