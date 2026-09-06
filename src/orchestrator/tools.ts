import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { computeFragility, formatFragilityFacts, type FragilityReport } from "./fragility/index.js";
import {
  defaultCheckSet,
  detectVerification,
  formatDetection,
  formatRun,
  runVerification,
  type CheckKind,
  type DetectionReport,
  type VerificationCheck,
  type VerificationProgress,
  type VerificationRun,
} from "./verification/index.js";
import type { GuardrailRule } from "./guardrails.js";
import { computeSubmission, formatSubmission, type SubmissionReport } from "./submission.js";
import { appendFeedbackEntry, readFeedbackLog, setFeedbackStale, type FeedbackLog } from "./feedback-log.js";
import { compareRuns, detectBenchmarks, formatBenchDetection, formatBenchRun, formatComparison, getBenchRun, listBenchRuns, runBenchmark, type BenchRun, type BenchTool } from "./benchmark.js";

/**
 * Mendophyte's in-process tools. These are the deterministic computations
 * the meta-prompt would otherwise ask the model to derive turn by turn;
 * exposing them as tools means the agent pulls each one at the moment its
 * phase needs it, and the orchestrator never has to guess when that is.
 *
 * Tool names as the model sees them: `mcp__mendophyte__<name>`.
 */

export const MENDOPHYTE_MCP_NAME = "mendophyte";
export const FRAGILITY_TOOL = `mcp__${MENDOPHYTE_MCP_NAME}__fragility_map`;
export const DETECT_VERIFICATION_TOOL = `mcp__${MENDOPHYTE_MCP_NAME}__detect_verification_commands`;
export const RUN_VERIFICATION_TOOL = `mcp__${MENDOPHYTE_MCP_NAME}__run_verification`;
export const SUBMISSION_STATUS_TOOL = `mcp__${MENDOPHYTE_MCP_NAME}__submission_status`;
export const FEEDBACK_LOG_TOOL = `mcp__${MENDOPHYTE_MCP_NAME}__feedback_log`;
export const BENCHMARK_TOOL = `mcp__${MENDOPHYTE_MCP_NAME}__benchmark`;

export interface MendophyteToolsConfig {
  repoDir: string;
  artifactHome?: string;
  guardrails?: GuardrailRule[];
  /** Called with every report so the server can cache it for the UI overlay. */
  onFragility?: (report: FragilityReport) => void;
  onVerificationDetected?: (report: DetectionReport) => void;
  onVerificationProgress?: (p: VerificationProgress) => void;
  onVerification?: (run: VerificationRun) => void;
  onSubmission?: (report: SubmissionReport) => void;
  onFeedbackLog?: (log: FeedbackLog) => void;
  onBenchmark?: (run: BenchRun) => void;
}

const CHECK_KINDS = ["format", "lint", "typecheck", "test", "build", "ci-local", "other"] as const;

export function createMendophyteMcpServer(cfg: MendophyteToolsConfig): McpSdkServerConfigWithInstance {
  const fragilityMap = tool(
    "fragility_map",
    [
      "Mendophyte's precomputed Phase 2 fragility-map inputs for the target repository:",
      "file churn from `git log --numstat`, fix/revert commit clustering by file and directory (with example commits to cite),",
      "and TODO/FIXME/HACK/XXX density from `git grep`, plus the count of files untouched in the window (a weak signal).",
      "Call this when you enter Phase 2 instead of running git log / git grep yourself.",
      "Pass `subpath` to narrow to one directory once a specific bug's area is known (Phase 3 deep pass, Phase 4).",
    ].join(" "),
    {
      subpath: z.string().optional().describe("Directory relative to the repository root to narrow the analysis to. Omit for the whole repository."),
      since: z.string().optional().describe('git --since expression for the history window. Default "3 years".'),
      top_n: z.number().int().min(3).max(50).optional().describe("How many entries per ranked list. Default 15."),
    },
    async (args) => {
      const report = await computeFragility({ repoDir: cfg.repoDir, subpath: args.subpath, since: args.since, topN: args.top_n });
      cfg.onFragility?.(report);
      return { content: [{ type: "text", text: formatFragilityFacts(report, args.top_n ?? 12) }], isError: Boolean(report.error) };
    },
    { annotations: { readOnlyHint: true, idempotentHint: true } }
  );

  const detectTool = tool(
    "detect_verification_commands",
    [
      "Reads the project's own machine-readable config (package.json scripts, Cargo.toml, go.mod, pyproject.toml/setup.cfg, Makefile, .pre-commit-config) and returns",
      "candidate lint / format-check / typecheck / test / build commands with their sources, the toolchain versions the project pins versus what is installed locally,",
      "and the literal `run:` steps its CI workflows execute. Use it in Phase 4 step 2 (convention detection) and step 10, and in Phase 5E. It runs nothing.",
    ].join(" "),
    {
      subpath: z.string().optional().describe("Subproject directory (monorepos), relative to the repository root. Omit for the root."),
    },
    async (args) => {
      const d = await detectVerification(cfg.repoDir, args.subpath);
      cfg.onVerificationDetected?.(d);
      return { content: [{ type: "text", text: formatDetection(d) }] };
    },
    { annotations: { readOnlyHint: true, idempotentHint: true } }
  );

  const runTool = tool(
    "run_verification",
    [
      "Actually runs verification commands in the repository and returns the real exit code, duration, and output tail of each, writing full logs under the artifact home.",
      "This is the ONLY basis on which you may say a lint, format, typecheck, test or build check passed (Phase 4 step 10, Phase 5E, and the guardrail against fabricated verification).",
      "Either pass `use_detected: true` to run the detected default set (format, lint, typecheck, test; nothing that modifies files), or pass explicit `checks` (e.g. commands from CONTRIBUTING or CI).",
      "Commands on the standing-guardrail list (commit, push, history rewrites, recursive deletes) are refused here; those go through your Bash tool so the user can confirm them.",
      "Runs are sequential; long suites can take minutes. If a suite is red before your change, say so: establish the baseline first, per Phase 4 step 7.",
    ].join(" "),
    {
      use_detected: z.boolean().optional().describe("Run the detected default set for this repository (or subpath)."),
      include_kinds: z.array(z.enum(CHECK_KINDS)).optional().describe("With use_detected: restrict/extend to these kinds (default format, lint, typecheck, test)."),
      subpath: z.string().optional().describe("Subproject directory for detection, relative to the repository root."),
      checks: z
        .array(
          z.object({
            id: z.string().optional().describe("Short label; defaults to the command."),
            command: z.string().describe("Shell command, exactly as the project documents it."),
            cwd: z.string().optional().describe("Directory relative to the repository root. Must stay inside it."),
            kind: z.enum(CHECK_KINDS).optional(),
            success_rule: z.enum(["exit-zero", "no-output"]).optional().describe("no-output for tools like `gofmt -l` that exit 0 but print offenders."),
          })
        )
        .optional()
        .describe("Explicit commands to run, in order."),
      timeout_minutes: z.number().min(0.1).max(120).optional().describe("Per-check timeout. Default 20."),
      fail_fast: z.boolean().optional().describe("Stop after the first non-pass. Default false."),
    },
    async (args) => {
      let checks: VerificationCheck[] = [];
      if (args.use_detected) {
        const d = await detectVerification(cfg.repoDir, args.subpath);
        cfg.onVerificationDetected?.(d);
        checks.push(...defaultCheckSet(d, args.include_kinds as CheckKind[] | undefined));
      }
      for (const c of args.checks ?? []) {
        checks.push({ id: c.id ?? c.command, kind: c.kind ?? "other", command: c.command, cwd: c.cwd, source: "passed explicitly by the agent", successRule: c.success_rule });
      }
      if (!checks.length) {
        return { content: [{ type: "text", text: "Nothing to run: no checks were detected for the default set and none were passed explicitly. Detect first, or pass the project's documented commands in `checks`." }], isError: true };
      }
      const run = await runVerification({
        repoDir: cfg.repoDir,
        artifactHome: cfg.artifactHome,
        checks,
        guardrails: cfg.guardrails,
        timeoutMs: args.timeout_minutes ? args.timeout_minutes * 60_000 : undefined,
        failFast: args.fail_fast,
        onProgress: cfg.onVerificationProgress,
      });
      cfg.onVerification?.(run);
      return { content: [{ type: "text", text: formatRun(run) }], isError: false };
    },
    { annotations: { readOnlyHint: false, idempotentHint: false } }
  );

  const submissionTool = tool(
    "submission_status",
    [
      "Phase 5 facts, observed rather than remembered: the pull request for the current branch (via gh or the anonymous forge API), CI status for its head commit,",
      "PR template compliance of the PR body or the Artifact E draft against the project's template, DCO sign-off on the branch's commits, and branch sync (ahead/behind base, unpushed).",
      "Use it in 5D/5E before opening the PR and in 5F on resume instead of asking the user what CI says. Pass fetch:true to `git fetch` the base remote first.",
    ].join(" "),
    {
      fetch: z.boolean().optional().describe("Run git fetch on the base remote first so ahead/behind is current. Default false."),
    },
    async (args) => {
      if (!cfg.artifactHome) return { content: [{ type: "text", text: "No artifact home configured for this session." }], isError: true };
      const report = await computeSubmission({ repoDir: cfg.repoDir, artifactHome: cfg.artifactHome, fetch: args.fetch });
      cfg.onSubmission?.(report);
      return { content: [{ type: "text", text: formatSubmission(report) }] };
    },
    { annotations: { readOnlyHint: true, idempotentHint: true } }
  );

  const feedbackTool = tool(
    "feedback_log",
    [
      "Artifact F, the per-project feedback log (05-submission.md section H). `action: read` returns every entry (do this in the resume check; weight entries above general merged history).",
      "`action: append` records one durable lesson from real feedback (the lesson, not a transcript) with tags and its source.",
      "`action: flag_stale` / `unflag_stale` marks an entry as possibly stale when live recon contradicts it, per the meta-prompt. The log is append-only otherwise.",
    ].join(" "),
    {
      action: z.enum(["read", "append", "flag_stale", "unflag_stale"]),
      lesson: z.string().optional().describe("append: the lesson in one or a few sentences."),
      tags: z.array(z.string()).optional().describe("append: short tags such as conventions, tests, review, ci, style."),
      source: z.string().optional().describe("append: where it came from, e.g. 'PR #482 review by @alice'."),
      entry_id: z.string().optional().describe("flag_stale/unflag_stale: the entry's timestamp id as returned by read."),
    },
    async (args) => {
      if (!cfg.artifactHome) return { content: [{ type: "text", text: "No artifact home configured for this session." }], isError: true };
      try {
        let log: FeedbackLog;
        if (args.action === "append") {
          const r = await appendFeedbackEntry(cfg.artifactHome, { lesson: args.lesson ?? "", tags: args.tags, source: args.source });
          log = r.log;
        } else if (args.action === "flag_stale" || args.action === "unflag_stale") {
          log = await setFeedbackStale(cfg.artifactHome, args.entry_id ?? "", args.action === "flag_stale");
        } else {
          log = await readFeedbackLog(cfg.artifactHome);
        }
        cfg.onFeedbackLog?.(log);
        const lines = [`Feedback log at ${log.path}${log.exists ? "" : " (not created yet)"}: ${log.entries.length} entries.`];
        for (const e of [...log.entries].reverse()) lines.push(`- ${e.id}${e.tags.length ? ` [${e.tags.join(", ")}]` : ""}${e.stale ? " (possibly stale)" : ""}: ${e.lesson}${e.source ? ` (source: ${e.source})` : ""}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
    { annotations: { readOnlyHint: false, idempotentHint: false } }
  );

  const benchmarkTool = tool(
    "benchmark",
    [
      "Performance sessions (Phase 3 baseline, Phase 4 step 7). `action: detect` finds the project's own benchmark tooling (criterion, go test -bench, pytest-benchmark, npm bench scripts).",
      "`action: run` executes a benchmark command, parses criterion / go bench / pytest-benchmark / hyperfine output into per-benchmark distributions (mean, sd, n, warm-up) and persists the run under the artifact home so the baseline survives.",
      "`action: list` shows saved runs; `action: compare` reports baseline → after per benchmark with Δ% and whether it clears noise (|Δ| > 2·√(sd₁²+sd₂²)). Use it instead of quoting a single number.",
    ].join(" "),
    {
      action: z.enum(["detect", "run", "list", "compare"]),
      command: z.string().optional().describe("run: the project's own benchmark command, exactly as documented."),
      label: z.string().optional().describe("run: e.g. 'baseline' or 'after fix'."),
      tool: z.enum(["criterion", "go-bench", "pytest-benchmark", "hyperfine", "unknown"]).optional().describe("run: override tool detection for parsing."),
      cwd: z.string().optional().describe("run: subdirectory relative to the repository root."),
      baseline_id: z.string().optional().describe("compare: run id of the baseline."),
      after_id: z.string().optional().describe("compare: run id of the candidate."),
    },
    async (args) => {
      if (!cfg.artifactHome) return { content: [{ type: "text", text: "No artifact home configured for this session." }], isError: true };
      try {
        if (args.action === "detect") return { content: [{ type: "text", text: formatBenchDetection(await detectBenchmarks(cfg.repoDir)) }] };
        if (args.action === "list") {
          const runs = await listBenchRuns(cfg.artifactHome);
          return { content: [{ type: "text", text: runs.length ? runs.map((r) => `- ${r.id} "${r.label}" ${r.ranAt} (${r.tool}, ${r.samples.length} benchmarks, ${r.status})`).join("\n") : "No saved benchmark runs." }] };
        }
        if (args.action === "run") {
          if (!args.command) return { content: [{ type: "text", text: "run needs `command`." }], isError: true };
          const run = await runBenchmark({ repoDir: cfg.repoDir, artifactHome: cfg.artifactHome, command: args.command, label: args.label, tool: args.tool as BenchTool | undefined, cwd: args.cwd, guardrails: cfg.guardrails });
          cfg.onBenchmark?.(run);
          return { content: [{ type: "text", text: formatBenchRun(run) }], isError: run.status !== "passed" };
        }
        const b = args.baseline_id ? await getBenchRun(cfg.artifactHome, args.baseline_id) : null;
        const a = args.after_id ? await getBenchRun(cfg.artifactHome, args.after_id) : null;
        if (!b || !a) return { content: [{ type: "text", text: "compare needs valid baseline_id and after_id (see action: list)." }], isError: true };
        return { content: [{ type: "text", text: formatComparison(compareRuns(b, a)) }] };
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    },
    { annotations: { readOnlyHint: false, idempotentHint: false } }
  );

  return createSdkMcpServer({
    name: MENDOPHYTE_MCP_NAME,
    version: "0.1.0",
    instructions:
      "Tools provided by Mendophyte, the local cockpit orchestrating this session. They return deterministic facts computed from the repository on disk; cite their output by the sources it names. A verification result from run_verification is the only thing you may call verified.",
    tools: [fragilityMap, detectTool, runTool, submissionTool, feedbackTool, benchmarkTool],
  });
}

/** Tool names to pre-approve so the agent's calls to Mendophyte's own tools never prompt. */
export const MENDOPHYTE_TOOL_ALLOWLIST = [FRAGILITY_TOOL, DETECT_VERIFICATION_TOOL, RUN_VERIFICATION_TOOL, SUBMISSION_STATUS_TOOL, FEEDBACK_LOG_TOOL, BENCHMARK_TOOL];
