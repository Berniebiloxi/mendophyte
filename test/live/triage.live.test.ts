/**
 * Live: the model can satisfy the triage part of the schema. We hand it
 * two made-up issues and ask for a shallow pass; the structured output
 * must validate and carry both candidates with named criteria.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

import { ApprovalBroker, MendophyteSession, type TurnEvent } from "../../src/orchestrator/index.js";

const LIVE = process.env.MENDOPHYTE_LIVE === "1";
const MODEL = process.env.MENDOPHYTE_TEST_MODEL ?? "haiku";
const root = path.resolve(new URL(".", import.meta.url).pathname, "../..");

test("live: shallow triage arrives as structured state with named criteria", { skip: !LIVE, timeout: 300_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-triage-live-"));
  const repoDir = path.join(base, "repo");
  await mkdir(repoDir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(path.join(repoDir, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const approvals = new ApprovalBroker();
  approvals.on("pending", (r) => approvals.resolve(r.id, { approved: false, reason: "test" }));
  const session = new MendophyteSession({ repoDir, artifactHome: path.join(base, "artifacts"), promptDir: path.join(root, "prompts"), approvals, model: MODEL, maxTurns: 6, persistSession: false });
  const turn = new Promise<TurnEvent>((res, rej) => {
    session.once("turn", res);
    session.once("error", rej);
    setTimeout(() => rej(new Error("no turn")), 240_000);
  });
  try {
    await session.start();
    session.send(
      [
        "Mechanical test of the triage board. Do not use any tools. This is a bug-fix session with local-clone-only access (no forge).",
        "The user pasted two issues:",
        "  Issue #12 'Crash when config path has spaces': includes exact repro steps and a stack trace; says it started in v1.4; no assignee info visible.",
        "  Issue #30 'Sometimes the cache is stale after restart': no repro steps; the reporter says it happens 'occasionally'.",
        "Produce the Phase 3 shallow pass for these two in your structured output: triage.mode 'shallow', task_type 'bug', both candidates ranked with scores using the bug criteria,",
        "marking anything that would need forge data as 'unobserved'. Add one your_turn_items entry of kind choose_candidate. phase 3, phase_complete false. One sentence of prose is enough.",
      ].join("\n")
    );
    const t = await turn;
    assert.equal(t.result.subtype, "success");
    assert.ok(t.state, `state missing: ${t.stateError}`);
    const tri = t.state!.triage;
    assert.ok(tri, "triage should be present");
    assert.equal(tri!.mode, "shallow");
    assert.equal(tri!.task_type, "bug");
    assert.equal(tri!.candidates.length, 2);
    const ranks = tri!.candidates.map((c) => c.rank).sort();
    assert.deepEqual(ranks, [1, 2]);
    const top = tri!.candidates.find((c) => c.rank === 1)!;
    assert.match(top.title + top.source, /12|spaces/i, "the reproducible issue should rank first");
    assert.ok(top.scores.some((s) => s.criterion === "reproducibility" && s.value === "positive"));
    const allScores = tri!.candidates.flatMap((c) => c.scores);
    assert.ok(allScores.some((s) => s.value === "unobserved"), "forge-dependent criteria should be marked unobserved");
    assert.ok(t.state!.your_turn_items.some((i) => i.kind === "choose_candidate"));
  } finally {
    session.close();
    await rm(base, { recursive: true, force: true });
  }
});
