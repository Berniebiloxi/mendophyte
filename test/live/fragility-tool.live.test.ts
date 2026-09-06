/**
 * Live: the agent can see and call Mendophyte's in-process fragility_map
 * tool, the call is pre-approved (no guardrail prompt), the session
 * surfaces the report on the `fragility` event, and the agent's answer
 * reflects the tool's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";

import { ApprovalBroker, FRAGILITY_TOOL, MendophyteSession, type FragilityReport, type TurnEvent } from "../../src/orchestrator/index.js";

const LIVE = process.env.MENDOPHYTE_LIVE === "1";
const MODEL = process.env.MENDOPHYTE_TEST_MODEL ?? "haiku";
const root = path.resolve(new URL(".", import.meta.url).pathname, "../..");

test("live: agent calls fragility_map and reports its top churn file", { skip: !LIVE, timeout: 300_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-fragility-live-"));
  const repoDir = path.join(base, "repo");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(path.join(repoDir, "src", "hotspot.ts"), "export const a = 1;\n// TODO: tidy\n");
  await writeFile(path.join(repoDir, "src", "quiet.ts"), "export const q = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  for (let i = 0; i < 3; i++) {
    await appendFile(path.join(repoDir, "src", "hotspot.ts"), `export const a${i} = ${i};\n`);
    git("add", "-A");
    git("commit", "-q", "-m", `fix: hotspot bug ${i}`);
  }

  const approvals = new ApprovalBroker();
  approvals.on("pending", (r) => approvals.resolve(r.id, { approved: false, reason: "test" }));
  const session = new MendophyteSession({ repoDir, artifactHome: path.join(base, "artifacts"), promptDir: path.join(root, "prompts"), approvals, model: MODEL, maxTurns: 8, persistSession: false });

  const toolUses: string[] = [];
  const bash: string[] = [];
  const texts: string[] = [];
  let report: FragilityReport | null = null;
  session.on("tool_use", (t) => {
    toolUses.push(t.name);
    if (t.name === "Bash") bash.push(String((t.input as any)?.command ?? ""));
  });
  session.on("assistant_text", (t) => texts.push(t));
  session.on("fragility", (r) => (report = r));
  const turn = new Promise<TurnEvent>((res, rej) => {
    session.once("turn", res);
    session.once("error", rej);
    setTimeout(() => rej(new Error(`no turn; tool uses=${JSON.stringify(toolUses)}`)), 240_000);
  });

  try {
    await session.start();
    session.send(
      "Mechanical tooling test. Call the mendophyte fragility_map tool once (no arguments), then in one sentence name the file with the most commits and how many fix commits it has, exactly as the tool reported. Do not run git yourself. Structured output: phase 2, phase_complete false, no your_turn_items."
    );
    const t = await turn;
    assert.equal(t.result.subtype, "success");
    assert.ok(toolUses.includes(FRAGILITY_TOOL), `expected ${FRAGILITY_TOOL} in ${JSON.stringify(toolUses)}`);
    // The model may still poke at git on its own; that is prompt adherence, not
    // a tooling failure. Report it so drift is visible without failing the run.
    if (bash.length) console.log(`# note: agent also ran Bash: ${JSON.stringify(bash)}`);
    assert.ok(!bash.some((c) => /git log .*--numstat|git grep/.test(c)), `agent re-derived the map with git despite the tool: ${JSON.stringify(bash)}`);
    assert.equal(approvals.pending().length, 0);
    assert.ok(report, "session should surface the report via the fragility event");
    assert.equal(report!.top.churn[0].path, "src/hotspot.ts");
    const all = texts.join("\n");
    assert.match(all, /hotspot\.ts/);
    assert.match(all, /3/);
    assert.equal(t.state?.phase, 2);
  } finally {
    session.close();
    await rm(base, { recursive: true, force: true });
  }
});
