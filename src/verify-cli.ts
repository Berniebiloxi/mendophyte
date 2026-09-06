#!/usr/bin/env node
/**
 * Detects a project's own verification commands and optionally runs them,
 * printing exactly what the agent would receive from the tools.
 *
 *   npm run verify -- --repo /path/to/clone                 # detect only
 *   npm run verify -- --repo /path/to/clone --run           # run the detected default set
 *   npm run verify -- --repo /path/to/clone --run --check "npm test" --check "cargo clippy"
 */
import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import { defaultCheckSet, detectVerification, formatDetection, formatRun, runVerification, type VerificationCheck } from "./orchestrator/verification/index.js";

const program = new Command()
  .name("mendophyte-verify")
  .requiredOption("--repo <dir>", "path to the target repository clone")
  .option("--subpath <dir>", "subproject directory, relative to the repo root")
  .option("--artifact-home <dir>", "where logs go (default ~/.mendophyte/<repo-name>)")
  .option("--run", "run the detected default set (plus any --check)")
  .option("--check <command>", "explicit command to run (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--timeout <minutes>", "per-check timeout", "20")
  .option("--json", "print JSON");

program.parse(process.argv);
const opts = program.opts<{ repo: string; subpath?: string; artifactHome?: string; run?: boolean; check: string[]; timeout: string; json?: boolean }>();

const repoDir = path.resolve(opts.repo);
const artifactHome = path.resolve(opts.artifactHome ?? path.join(os.homedir(), ".mendophyte", path.basename(repoDir)));
const detected = await detectVerification(repoDir, opts.subpath);

if (!opts.run) {
  console.log(opts.json ? JSON.stringify(detected, null, 2) : formatDetection(detected));
} else {
  const checks: VerificationCheck[] = [...defaultCheckSet(detected)];
  for (const c of opts.check) checks.push({ id: c, kind: "other", command: c, source: "--check", cwd: opts.subpath });
  const run = await runVerification({
    repoDir,
    artifactHome,
    checks,
    timeoutMs: Number(opts.timeout) * 60_000,
    onProgress: (p) => {
      if (p.phase === "start") process.stderr.write(`[${p.index + 1}/${p.total}] ${p.check.command} …\n`);
      else process.stderr.write(`[${p.index + 1}/${p.total}] ${p.result.status.toUpperCase()} (${(p.result.durationMs / 1000).toFixed(1)}s)\n`);
    },
  });
  console.log(opts.json ? JSON.stringify(run, null, 2) : formatRun(run));
  process.exitCode = run.allPassed ? 0 : 1;
}
