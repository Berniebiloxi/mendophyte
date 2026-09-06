#!/usr/bin/env node
/**
 * Runs the deterministic Phase 0 checks against a clone and prints the
 * facts block exactly as the agent would receive it (or the raw JSON).
 * No model involved; useful for checking what a repo looks like to
 * Mendophyte before spending a session on it.
 *
 *   npm run preflight -- --repo /path/to/clone [--artifact-home DIR] [--repo-url URL] [--json]
 */
import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import { formatPreflightFacts, runPreflight } from "./orchestrator/preflight/index.js";

const program = new Command()
  .name("mendophyte-preflight")
  .requiredOption("--repo <dir>", "path to the target repository clone")
  .option("--artifact-home <dir>", "artifact home (default ~/.mendophyte/<repo-name>)")
  .option("--repo-url <url>", "forge URL to use if the clone has no origin remote")
  .option("--json", "print the raw report as JSON instead of the facts block");

program.parse(process.argv);
const opts = program.opts<{ repo: string; artifactHome?: string; repoUrl?: string; json?: boolean }>();

const repoDir = path.resolve(opts.repo);
const artifactHome = path.resolve(opts.artifactHome ?? path.join(os.homedir(), ".mendophyte", path.basename(repoDir)));

const report = await runPreflight({ repoDir, artifactHome, repoUrl: opts.repoUrl });
if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatPreflightFacts(report));
}
