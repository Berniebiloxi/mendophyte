#!/usr/bin/env node
/**
 * Prints the Phase 2 fragility-map inputs for a clone, as the agent would
 * receive them from the fragility_map tool, or as JSON for the overlay.
 *
 *   npm run fragility -- --repo /path/to/clone [--subpath src/parser] [--since "2 years"] [--json]
 */
import { Command } from "commander";
import path from "node:path";
import { computeFragility, formatFragilityFacts } from "./orchestrator/fragility/index.js";

const program = new Command()
  .name("mendophyte-fragility")
  .requiredOption("--repo <dir>", "path to the target repository clone")
  .option("--subpath <dir>", "narrow to one directory (relative to the repo root)")
  .option("--since <expr>", 'git --since expression (default "3 years")')
  .option("--top <n>", "entries per ranked list", "15")
  .option("--json", "print the raw report as JSON");

program.parse(process.argv);
const opts = program.opts<{ repo: string; subpath?: string; since?: string; top: string; json?: boolean }>();

const report = await computeFragility({ repoDir: path.resolve(opts.repo), subpath: opts.subpath, since: opts.since, topN: Number(opts.top) });
console.log(opts.json ? JSON.stringify(report, null, 2) : formatFragilityFacts(report, Number(opts.top)));
