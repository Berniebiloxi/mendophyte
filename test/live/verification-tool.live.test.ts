/**
 * Live: the agent detects and runs the project's own checks through
 * Mendophyte's tools, and reports the real result (one pass, one fail)
 * rather than a self-declared checkmark. The session surfaces the run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

import { ApprovalBroker, DETECT_VERIFICATION_TOOL, MendophyteSession, RUN_VERIFICATION_TOOL, type TurnEvent, type VerificationRun } from "../../src/orchestrator/index.js";

const LIVE = process.env.MENDOPHYTE_LIVE === "1";
const MODEL = process.env.MENDOPHYTE_TEST_MODEL ?? "haiku";
const root = path.resolve(new URL(".", import.meta.url).pathname, "../..");

test("live: agent runs verification through the tool and reports the real outcome", { skip: !LIVE, timeout: 300_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-verify-live-"));
  const repoDir = path.join(base, "repo");
  await mkdir(repoDir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "fx", scripts: { test: `${node} test.js`, lint: `${node} lint.js` } }, null, 2));
  await writeFile(path.join(repoDir, "test.js"), "console.log('2 tests passed');\n");
  await writeFile(path.join(repoDir, "lint.js"), "console.error('lint error: unused variable x in test.js:1'); process.exit(1);\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const approvals = new ApprovalBroker();
  approvals.on("pending", (r) => approvals.resolve(r.id, { approved: false, reason: "test" }));
  const session = new MendophyteSession({ repoDir, artifactHome: path.join(base, "artifacts"), promptDir: path.join(root, "prompts"), approvals, model: MODEL, maxTurns: 16, persistSession: false });

  const toolUses: string[] = [];
  const texts: string[] = [];
  let run: VerificationRun | null = null;
  session.on("tool_use", (t) => toolUses.push(t.name === "Bash" ? `Bash(${String((t.input as any)?.command ?? "").slice(0, 60)})` : t.name));
  session.on("assistant_text", (t) => texts.push(t));
  session.on("verification", (r) => (run = r));
  const turn = new Promise<TurnEvent>((res, rej) => {
    session.once("turn", res);
    session.once("error", rej);
    setTimeout(() => rej(new Error(`no turn; tool uses=${JSON.stringify(toolUses)}`)), 240_000);
  });

  try {
    await session.start();
    session.send(
      [
        "Mechanical tooling test. Do these steps in order:",
        "1. call mendophyte detect_verification_commands;",
        "2. call mendophyte run_verification with use_detected true;",
        "3. write two or three sentences of prose stating, for each check, whether it passed or failed and its exit code, exactly as the tool reported;",
        "4. emit the structured output (phase 4, phase_complete false, no your_turn_items).",
        "A failing check is the expected result of this test: do not investigate it, do not read files, do not run npm or node yourself, do not retry.",
      ].join("\n")
    );
    const t = await turn;
    assert.ok(toolUses.includes(DETECT_VERIFICATION_TOOL), `expected detect tool in ${JSON.stringify(toolUses)}`);
    assert.ok(toolUses.includes(RUN_VERIFICATION_TOOL), `expected run tool in ${JSON.stringify(toolUses)}`);
    assert.equal(t.result.subtype, "success", `result ${t.result.subtype}; tool uses=${JSON.stringify(toolUses)}`);
    assert.ok(run, "session should surface the verification run");
    const by = Object.fromEntries(run!.results.map((r) => [r.id, r]));
    assert.equal(by["npm:test"].status, "passed");
    assert.equal(by["npm:lint"].status, "failed");
    assert.equal(by["npm:lint"].exitCode, 1);
    const all = texts.join("\n").toLowerCase();
    assert.match(all, /test/);
    assert.match(all, /lint/);
    assert.match(all, /fail/);
    assert.equal(t.state?.phase, 4);
  } finally {
    session.close();
    await rm(base, { recursive: true, force: true });
  }
});
