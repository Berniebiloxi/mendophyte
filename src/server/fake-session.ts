import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendFeedbackEntry, matchGuardrail, runBenchmark, type SessionConfig } from "../orchestrator/index.js";
import type { SessionLike } from "./session-manager.js";

/**
 * Dev-only scripted stand-in for the Agent SDK session, enabled with
 * MENDOPHYTE_FAKE_SESSION=1. Walks the UI through the shapes it has to
 * handle (questions in the your-turn queue, tool use, a guardrail
 * confirmation, a locked diff, verification) without spending tokens.
 * Never used unless that env var is set.
 */
export class FakeSession extends EventEmitter implements SessionLike {
  sessionId: string | null = null;
  lastState: any = null;
  private step = 0;
  private closed = false;

  constructor(public config: SessionConfig) {
    super();
  }

  async start() {
    setTimeout(() => {
      if (this.closed) return;
      this.sessionId = `fake-${Date.now().toString(36)}`;
      this.emit("init", { sessionId: this.sessionId, model: "fake", permissionMode: "default", tools: ["Read", "Bash"] });
    }, 200);
  }

  send(text: string) {
    if (this.closed) return;
    const n = this.step++;
    setTimeout(() => void this.script(n, text), 400);
  }

  async interrupt() {}
  end() {
    this.closed = true;
    this.emit("end");
  }
  close() {
    this.closed = true;
  }

  private say(text: string) {
    this.emit("assistant_text", text);
  }
  private tool(name: string, input: unknown) {
    this.emit("tool_use", { name, input, id: `t${Math.random().toString(36).slice(2, 8)}` });
  }
  private state(s: any) {
    this.lastState = s;
    this.emit("state", s);
    this.emit("turn", { result: { type: "result", subtype: "success", is_error: false, num_turns: 3 + this.step, total_cost_usd: 0.012 * (this.step + 1), session_id: this.sessionId }, state: s });
  }
  private async bash(command: string): Promise<boolean> {
    const match = matchGuardrail(command);
    if (!match) {
      this.tool("Bash", { command });
      return true;
    }
    const d = await this.config.approvals.request({ toolName: "Bash", input: { command }, command, match, cwd: this.config.repoDir });
    if (d.approved) this.tool("Bash", { command });
    else this.say(`Understood, I won't run \`${command}\`${d.reason ? ` (${d.reason})` : ""}. Tell me when you'd like to proceed.`);
    return d.approved;
  }

  private async script(n: number, text: string) {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    switch (n) {
      case 0:
        this.tool("Read", { file_path: `${this.config.promptDir}/00-entry.md` });
        await delay(500);
        this.say("I've read 00-entry.md and the pre-flight facts you handed me. Before anything else, two gating questions, one at a time.\n\n**How much experience do you have reading other people's code?** None, Some, or Experienced.");
        this.state({ phase: 0, phase_complete: false, your_turn_items: [{ id: "experience_level", kind: "answer_question", prompt: "How much experience do you have reading other people's code? (None / Some / Experienced)", blocks: "none" }] });
        return;
      case 1:
        this.say(`Noted: ${text.split("\n").pop()}. Second question.\n\n**What do you want to do here?** 1) a specific bug in mind, 2) find me something, 3) just understand the codebase.`);
        this.state({ phase: 0, phase_complete: false, your_turn_items: [{ id: "session_type", kind: "answer_question", prompt: "What do you want to do here? (1 specific bug / 2 find something / 3 just understand)", blocks: "none" }] });
        return;
      case 2:
        this.say("Thanks. Phase 0 is done; moving to Phase 1 and reading 01-recon.md.");
        this.tool("Read", { file_path: `${this.config.promptDir}/01-recon.md` });
        await delay(600);
        await this.bash("git log --oneline -20");
        this.tool("mcp__mendophyte__fragility_map", {});
        await delay(400);
        // Write Artifact A and a Glossary so the buds bloom and the viewers have something to show.
        this.tool("Write", { file_path: path.join(this.config.artifactHome, "A-recon-notes.md") });
        await writeFile(
          path.join(this.config.artifactHome, "A-recon-notes.md"),
          "# Recon Notes (Artifact A)\n\n*Fake session fixture.*\n\n1. **Language / build / tests**: TypeScript, npm scripts (`package.json` scripts.test), node:test. Source: `package.json`.\n2. **Monorepo**: single project. Inference: no workspaces field.\n3. **Architecture docs**: none found (checked ARCHITECTURE.md, docs/adr/).\n\n| Signal | Evidence |\n|---|---|\n| churn | `src/parser/lexer.ts` 4 commits (git log) |\n| fixes | 2 of 4 commits fix-like |\n"
        ).catch(() => {});
        await writeFile(
          path.join(this.config.artifactHome, "D-glossary.md"),
          "# Glossary (Artifact D)\n\n- **churn** — how often a file changes in git history. Introduced in Phase 2.\n- **astral plane** — Unicode code points above U+FFFF, which UTF-16 stores as two units. Introduced in Phase 4.\n"
        ).catch(() => {});
        this.say("Recon notes drafted to Artifact A. On to Phase 3. I scanned the open issues (full forge access); here are three ranked candidates, with two filtered out. Pick one from the Triage board and I'll do the deep pass.");
        this.state({
          phase: 3,
          phase_complete: false,
          your_turn_items: [{ id: "choose", kind: "choose_candidate", prompt: "Which candidate should go into the deep pass? (#1 lexer unicode, #2 CLI flag parsing, #3 flaky retry test)", blocks: "none" }],
          triage: {
            mode: "shallow",
            task_type: "bug",
            none_tractable: null,
            chosen: null,
            candidates: [
              {
                id: "issue-482",
                rank: 1,
                title: "Lexer mis-tokenises astral-plane code points",
                source: "https://github.com/example/proj/issues/482",
                reason: "Clear repro with a one-line input, points at a specific version, nobody assigned.",
                scores: [
                  { criterion: "reproducibility", value: "positive", note: "issue has a minimal input that fails" },
                  { criterion: "staleness_or_claimed", value: "positive", note: "no assignee, no linked PR" },
                  { criterion: "discussion_complexity", value: "positive", note: "3 comments, all agree it's a bug" },
                  { criterion: "bisectability", value: "positive", note: "reporter names v2.3 as the first bad version" },
                  { criterion: "environment_hardware_fit", value: "positive", note: "" },
                  { criterion: "project_health", value: "neutral", note: "CI green on main as of today" },
                  { criterion: "maintainer_receptiveness", value: "positive", note: "maintainer labelled it 'bug' and 'help wanted'" },
                  { criterion: "root_cause_location", value: "positive", note: "src/parser/lexer.ts, no dependency involved" },
                  { criterion: "determinism", value: "positive", note: "" },
                  { criterion: "data_state_dependencies", value: "positive", note: "pure function" },
                  { criterion: "label_signal", value: "positive", note: "" },
                ],
              },
              {
                id: "issue-455",
                rank: 2,
                title: "`--config` flag ignored when given before the subcommand",
                source: "https://github.com/example/proj/issues/455",
                reason: "Reproducible and small, but a maintainer floated a redesign of flag parsing in the thread.",
                scores: [
                  { criterion: "reproducibility", value: "positive", note: "command line given" },
                  { criterion: "staleness_or_claimed", value: "neutral", note: "someone said 'I can look' 6 weeks ago, no PR" },
                  { criterion: "discussion_complexity", value: "negative", note: "redesign vs. quick fix debated" },
                  { criterion: "bisectability", value: "neutral", note: "" },
                  { criterion: "maintainer_receptiveness", value: "neutral", note: "" },
                  { criterion: "root_cause_location", value: "positive", note: "src/cli/args.ts" },
                  { criterion: "determinism", value: "positive", note: "" },
                ],
              },
              {
                id: "issue-501",
                rank: 3,
                title: "Retry test occasionally times out on CI",
                source: "https://github.com/example/proj/issues/501",
                reason: "Real, but timing-dependent: needs many runs and statistical confidence.",
                scores: [
                  { criterion: "reproducibility", value: "negative", note: "1 in ~20 CI runs" },
                  { criterion: "determinism", value: "negative", note: "timing-dependent" },
                  { criterion: "environment_hardware_fit", value: "unobserved", note: "CI runner class not visible" },
                  { criterion: "project_health", value: "neutral", note: "" },
                  { criterion: "root_cause_location", value: "neutral", note: "could be the test, could be the retry logic" },
                ],
              },
            ],
            filtered_out: [
              { title: "#470 crash on Windows paths", reason: "already has an open PR from a maintainer" },
              { title: "#399 slow startup", reason: "performance work; this is a bug-fix session" },
            ],
          },
        });
        return;
      case 3: {
        const pick = /candidate #2\b|issue-455|--config/i.test(text) ? "issue-455" : /candidate #3\b|issue-501|retry|flaky/i.test(text) ? "issue-501" : "issue-482";
        this.say(`Deep pass on ${pick}. Root cause is in this repo, it reproduces on the first try, the change is contained to one function, and the blast radius is limited to inputs outside the BMP. Doable now.\n\nPer our split: before I show you anything, **state your hypothesis** about where the bug lives.`);
        const prev = this.lastState?.triage;
        this.state({
          phase: 3,
          phase_complete: true,
          your_turn_items: [{ id: "hypothesis", kind: "state_hypothesis", prompt: "Where do you think the lexer bug lives, and why?", blocks: "diff" }],
          triage: {
            ...prev,
            mode: "deep",
            chosen: {
              candidate_id: pick,
              root_cause_in_repo: "yes",
              reproducible_or_baseline: "yes",
              scope: "one_function",
              danger: "ripples",
              danger_reason: "Tokeniser output feeds every later stage; a wrong fix would surface as parse errors elsewhere, but only for non-BMP input.",
              doability: "yes",
              doability_reason: "Build passed in 40s; test suite runs in under a minute.",
              time_to_first_build: "ok",
              escalated_by_compatibility: false,
            },
          },
        });
        return;
      }
      case 4: {
        // Two fake benchmark runs (go-bench text via printf) so the panel has a baseline and an after to compare.
        const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
        const gen = (base: number, jitter: number) => `${node} -e "for(let i=0;i<6;i++){console.log('BenchmarkLexer-8 1000 '+(${base}+Math.round((Math.random()-0.5)*${jitter}))+' ns/op 128 B/op 2 allocs/op');console.log('BenchmarkParse-8 500 '+(${base * 3}+Math.round((Math.random()-0.5)*${jitter * 2}))+' ns/op')}"`;
        this.tool("mcp__mendophyte__benchmark", { action: "run", label: "baseline" });
        await runBenchmark({ repoDir: this.config.repoDir, artifactHome: this.config.artifactHome, command: gen(1200, 120), label: "baseline", tool: "go-bench" }).catch(() => {});
        this.tool("mcp__mendophyte__benchmark", { action: "run", label: "after fix" });
        await runBenchmark({ repoDir: this.config.repoDir, artifactHome: this.config.artifactHome, command: gen(900, 120), label: "after fix", tool: "go-bench" }).catch(() => {});
        this.say("That matches what I see. I've made the change and want to commit it as a checkpoint before writing the regression test.");
        await delay(300);
        await this.bash('git commit -am "fix(lexer): handle astral-plane code points"');
        this.tool("mcp__mendophyte__run_verification", { use_detected: true });
        this.state({ phase: 4, phase_complete: false, your_turn_items: [{ id: "write_test", kind: "write_test", prompt: "Write the first version of the failing regression test; I'll check it against the project's conventions.", blocks: "none" }] });
        return;
      }
      default:
        this.tool("Write", { file_path: path.join(this.config.artifactHome, "E-submission.md") });
        await writeFile(
          path.join(this.config.artifactHome, "E-submission.md"),
          "## Summary\n\nFix astral-plane code point handling in the lexer (fixes #482).\n\n## Test plan\n\n- regression test `lexer.test.ts` fails before, passes after\n\n## Checklist\n- [x] I have added tests\n- [ ] I have updated the docs\n"
        ).catch(() => {});
        this.tool("mcp__mendophyte__submission_status", {});
        this.tool("mcp__mendophyte__feedback_log", { action: "append", tags: ["tests", "conventions"] });
        await appendFeedbackEntry(this.config.artifactHome, {
          lesson: "Regression tests for parser bugs go under tests/parser/, named after the issue number; the maintainers asked for this on a previous PR.",
          tags: ["tests", "conventions"],
          source: "PR #430 review by @maintainer (fake fixture)",
        }).catch(() => {});
        this.say("Drafted the PR description to Artifact E; the Submission panel shows template compliance and CI. Per the Standing Guardrails I will not open the PR without your explicit go-ahead. (End of the scripted fake session.)");
        this.state({ phase: 5, phase_complete: false, your_turn_items: [{ id: "go_pr", kind: "confirm_go_ahead", prompt: "Open the pull request as drafted in Artifact E?", blocks: "pr_draft" }] });
    }
  }
}
