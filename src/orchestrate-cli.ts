#!/usr/bin/env node
/**
 * Terminal harness for the orchestration layer. No frontend involved:
 * it runs a real session against a repo, prints what the agent says and
 * does, shows the structured dashboard state after every turn, and asks
 * y/n in the terminal whenever a guardrail command needs approval.
 *
 *   npm run orchestrate -- --repo /path/to/clone [--artifact-home DIR]
 *                          [--model haiku] [--repo-url URL] [--kickoff "text"]
 *
 * Type a line to send it to the agent. `/end` finishes the session
 * gracefully, `/interrupt` stops the current turn, `/state` reprints the
 * last dashboard state, `/pending` lists open approvals.
 */
import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import readline from "node:readline";

import {
  ApprovalBroker,
  MendophyteSession,
  buildKickoffMessage,
  defaultPromptDir,
  formatPreflightFacts,
  runPreflight,
} from "./orchestrator/index.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const program = new Command()
  .name("mendophyte-orchestrate")
  .requiredOption("--repo <dir>", "path to the target repository clone")
  .option("--artifact-home <dir>", "artifact home (default ~/.mendophyte/<repo-name>)")
  .option("--prompt-dir <dir>", "directory holding 00-entry.md .. 05-submission.md", defaultPromptDir())
  .option("--model <model>", "model alias or id (default: your Claude Code default)")
  .option("--repo-url <url>", "repository URL to hand the agent in the kickoff")
  .option("--kickoff <text>", "override the kickoff message entirely")
  .option("--max-turns <n>", "cap agentic turns per user message")
  .option("--no-kickoff", "start the session but send nothing until you type")
  .option("--no-preflight", "skip the deterministic Phase 0 checks (the agent will probe on its own)")
  .option("--show-preflight", "print the pre-flight facts block before starting the session");

program.parse(process.argv);
const opts = program.opts<{
  repo: string;
  artifactHome?: string;
  promptDir: string;
  model?: string;
  repoUrl?: string;
  kickoff?: string | false;
  maxTurns?: string;
  preflight: boolean;
  showPreflight?: boolean;
}>();

const repoDir = path.resolve(opts.repo);
const artifactHome = path.resolve(
  opts.artifactHome ?? path.join(os.homedir(), ".mendophyte", path.basename(repoDir))
);
await mkdir(artifactHome, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));

const approvals = new ApprovalBroker();
approvals.on("pending", async (req) => {
  console.log("");
  console.log(red(bold("GUARDRAIL: ")) + bold(req.match.description) + dim(`  [${req.match.ruleId}, ${req.match.severity}]`));
  console.log(`  cwd:     ${req.cwd}`);
  console.log(`  command: ${bold(req.command)}`);
  const a = (await ask(yellow("  allow this exact command? [y/N] "))).trim().toLowerCase();
  approvals.resolve(req.id, a === "y" || a === "yes" ? { approved: true, decidedBy: "cli" } : { approved: false, decidedBy: "cli" });
});

const session = new MendophyteSession({
  repoDir,
  artifactHome,
  promptDir: path.resolve(opts.promptDir),
  approvals,
  model: opts.model,
  maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined,
  onStderr: (s) => process.stderr.write(dim(s)),
});

session.on("assistant_text", (t) => console.log("\n" + t));
session.on("tool_use", (t) => {
  const summary = t.name === "Bash" ? String((t.input as any)?.command ?? "") : JSON.stringify(t.input).slice(0, 160);
  console.log(dim(`  ▸ ${t.name} ${summary}`));
});
session.on("turn", ({ result, state, stateError }) => {
  const cost = result.subtype === "success" ? ` cost so far $${result.total_cost_usd.toFixed(4)}` : "";
  console.log(dim(`\n── turn done (${result.subtype}, ${result.num_turns} agentic turns${cost}) ──`));
  if (state) {
    console.log(green(`   phase ${state.phase}${state.phase_complete ? " (complete)" : ""}`));
    for (const item of state.your_turn_items) {
      console.log(green(`   your turn · ${item.kind}${item.blocks !== "none" ? ` · blocks ${item.blocks}` : ""}`) + `: ${item.prompt}`);
    }
  } else {
    console.log(yellow(`   no dashboard state: ${stateError}`));
  }
  rl.prompt();
});
session.on("error", (e) => console.error(red(`session error: ${e.message}`)));
session.on("end", () => {
  console.log(dim("session ended"));
  rl.close();
  process.exit(0);
});

session.on("init", ({ sessionId, model, permissionMode }) =>
  console.log(dim(`session ${sessionId} · model ${model} · permissions ${permissionMode}`))
);
await session.start();
console.log(dim(`repo ${repoDir}\nartifacts ${artifactHome}\nprompts ${opts.promptDir}`));

if (opts.kickoff !== false) {
  if (typeof opts.kickoff === "string") {
    session.send(opts.kickoff);
  } else {
    let facts: string | undefined;
    let repoUrl = opts.repoUrl;
    if (opts.preflight) {
      console.log(dim("running Phase 0 pre-flight checks…"));
      const report = await runPreflight({ repoDir, artifactHome, repoUrl: opts.repoUrl });
      facts = formatPreflightFacts(report);
      repoUrl ??= report.capability.forge?.webUrl;
      const tier = report.capability.tier;
      const h = report.health;
      console.log(
        dim(
          `pre-flight: tier ${tier}; repo ${h.observed ? `public ${h.public}, archived ${h.archived}` : "health unobserved"}; ` +
            `${report.policy.files.length} policy file(s); ${report.artifacts.entries.length} artifact(s) present`
        )
      );
      if (opts.showPreflight) console.log("\n" + facts + "\n");
    }
    session.send(buildKickoffMessage({ repoUrl, facts }));
  }
}

rl.setPrompt(bold("you> "));
rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === "/end") return session.end();
  if (text === "/quit") return session.close();
  if (text === "/interrupt") {
    await session.interrupt();
    return rl.prompt();
  }
  if (text === "/state") {
    console.log(JSON.stringify(session.lastState, null, 2));
    return rl.prompt();
  }
  if (text === "/pending") {
    console.log(approvals.pending());
    return rl.prompt();
  }
  session.send(text);
});
