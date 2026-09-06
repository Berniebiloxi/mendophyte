import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The three sections of `00-entry.md` that the meta-prompt says apply in
 * every phase. Per the handoff, these go into the session's appended
 * system prompt once, verbatim, rather than being re-injected per phase.
 */
export const PERSISTENT_SECTION_HEADINGS = [
  "How This Splits Between Us",
  "Artifacts",
  "Standing Guardrails",
] as const;

export type PersistentSectionName = (typeof PERSISTENT_SECTION_HEADINGS)[number];

export interface PersistentSections {
  /** Each section's markdown, heading line included, exactly as written. */
  sections: Record<PersistentSectionName, string>;
  /** The three sections concatenated in file order. */
  combined: string;
}

/**
 * Slices the three persistent sections out of the `00-entry.md` text.
 *
 * A section runs from its `## Heading` line to the line before the next
 * `## ` heading (or end of file). Trailing `---` separators and blank
 * lines are trimmed, nothing inside a section is altered.
 *
 * Throws if any of the three headings is missing, so a drifted or edited
 * entry file fails loudly at session start instead of silently seeding an
 * incomplete prompt.
 */
export function extractPersistentSections(entryMarkdown: string): PersistentSections {
  const lines = entryMarkdown.split(/\r?\n/);
  const headingIdx: { title: string; line: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^## (.+?)\s*$/.exec(l);
    if (m) headingIdx.push({ title: m[1], line: i });
  });

  const sections = {} as Record<PersistentSectionName, string>;
  for (const wanted of PERSISTENT_SECTION_HEADINGS) {
    const pos = headingIdx.findIndex((h) => h.title === wanted);
    if (pos === -1) {
      throw new Error(
        `00-entry.md is missing the "## ${wanted}" section; refusing to seed the system prompt from it.`
      );
    }
    const start = headingIdx[pos].line;
    const end = pos + 1 < headingIdx.length ? headingIdx[pos + 1].line : lines.length;
    const body = lines.slice(start, end);
    // Trim trailing separators/blank lines only.
    while (body.length && /^(\s*|---)$/.test(body[body.length - 1])) body.pop();
    sections[wanted] = body.join("\n");
  }

  const combined = PERSISTENT_SECTION_HEADINGS.map((h) => sections[h]).join("\n\n---\n\n");
  return { sections, combined };
}

export const META_PROMPT_FILES = [
  "00-entry.md",
  "01-recon.md",
  "02-orientation.md",
  "03-triage.md",
  "04-fix.md",
  "05-submission.md",
] as const;

/** Reads and slices `00-entry.md` from the directory holding the six meta-prompt files. */
export async function loadPersistentSections(promptDir: string): Promise<PersistentSections> {
  const text = await readFile(path.join(promptDir, "00-entry.md"), "utf8");
  return extractPersistentSections(text);
}

export interface AppendPromptContext {
  promptDir: string;
  artifactHome: string;
  repoDir: string;
}

/**
 * Builds the text handed to `systemPrompt.append`. It is a short framing
 * preamble (where things live on disk, what Mendophyte enforces
 * mechanically) followed by the three persistent sections verbatim.
 *
 * Deliberately does NOT include Phase 0 or the loading rules: the agent
 * reads `00-entry.md` itself with its Read tool, per the meta-prompt's own
 * design, and the orchestrator only decides when a session starts.
 */
export function buildAppendSystemPrompt(
  sections: PersistentSections,
  ctx: AppendPromptContext
): string {
  const preamble = [
    "# Mendophyte session context",
    "",
    "You are running inside Mendophyte, a local cockpit that orchestrates this",
    "open-source contribution workflow. Facts about this session:",
    "",
    `- The target repository clone is the working directory: ${ctx.repoDir}`,
    `- The meta-prompt files (${META_PROMPT_FILES.join(", ")}) live in: ${ctx.promptDir}`,
    "  Read them from there with your Read tool, following the loading rules",
    "  in 00-entry.md exactly (one phase file at a time, at the moment you",
    "  enter that phase).",
    `- The artifact home for this repository is already chosen: ${ctx.artifactHome}`,
    "  Artifacts A-F live there as real files, outside the repository. Do not",
    "  ask where to keep them; do check whether any already exist there.",
    "- Mendophyte enforces the Standing Guardrails mechanically as well as",
    "  asking you to honour them: commands such as git commit, git push,",
    "  force-pushes, hard resets, history rewrites, recursive deletes and",
    "  opening a pull request pause until the user confirms them in the",
    "  Mendophyte UI. A denial means the user declined; do not retry it",
    "  unchanged or route around it.",
    "- Some checks the meta-prompt asks you to perform (forge access probes,",
    "  repo health, CI/lint/test results) may be handed to you as already-run",
    "  facts in a user message. Treat those as observed, cite them as such,",
    "  and do not re-run them unless something has changed.",
    "- Mendophyte also provides in-process tools under the `mendophyte` MCP",
    "  server. In Phase 2, call `mcp__mendophyte__fragility_map` for the",
    "  fragility-map inputs (churn, fix/revert clustering, TODO/FIXME/HACK",
    "  density) instead of re-deriving them with git log and grep; narrow it",
    "  with `subpath` once a bug's area is known. Cite its output by the",
    "  sources and counts it names, never as a score.",
    "- The dashboard's triage board is driven only by the `triage` field of",
    "  your structured output: one card per candidate with the named scoring",
    "  criteria from 03-triage.md, then the deep-pass card with the danger",
    "  rating for the chosen task. Score a criterion `unobserved` whenever the",
    "  forge data it needs is out of reach at the current capability tier.",
    "- Artifact F, the feedback log, is a file in the artifact home with a",
    "  fixed entry format; use `mcp__mendophyte__feedback_log` to read it in",
    "  the resume check and to append lessons (the lesson, not the",
    "  transcript) or flag an entry stale. The user can add entries too.",
    "- For a performance session, `mcp__mendophyte__benchmark` runs the",
    "  project's own benchmark tool, keeps the distribution (mean, spread, n,",
    "  warm-up) and persists runs so the Phase 3 baseline can be compared with",
    "  the Phase 4 result; never quote a single number from it.",
    "- In Phase 5 (and on a resume into 5F), call",
    "  `mcp__mendophyte__submission_status` for the PR, CI, template",
    "  compliance, sign-off and branch-sync facts; the Submission panel polls",
    "  the same source, so CI state never comes from memory or from me.",
    "- For verification (Phase 4 steps 2 and 10, Phase 5E): call",
    "  `mcp__mendophyte__detect_verification_commands` to see the project's",
    "  own lint/format/typecheck/test commands, toolchain pins and CI steps,",
    "  then `mcp__mendophyte__run_verification` to actually run them. Its",
    "  report is the only basis for saying a check passed; the UI shows the",
    "  same results, so a claim that isn't in it will be visible as such.",
    "",
    "The three sections below are from 00-entry.md and apply in every phase.",
    "They are reproduced here so they stay in force even when a phase file",
    "is what is open in front of you.",
    "",
    "---",
    "",
  ].join("\n");
  return preamble + sections.combined + "\n";
}
