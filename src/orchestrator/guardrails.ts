/**
 * Guardrail matching for Bash commands.
 *
 * This is the mechanical half of `00-entry.md`'s Standing Guardrails: the
 * commands that must never run without the user first seeing the exact
 * command and clicking through. Matching is deliberately conservative
 * (prefers a false "needs confirmation" over a miss), and runs against the
 * whole command string so chained forms like `a && git push` are caught.
 *
 * The list is a plain array so the UI or a preferences file can extend it.
 */

export interface GuardrailRule {
  /** Stable identifier the UI can key on (e.g. to pick an icon or severity). */
  id: string;
  /** One-line human description shown in the confirm modal. */
  description: string;
  /** Severity hint for the UI. `critical` rules are the irreversible ones. */
  severity: "confirm" | "critical";
  test: (command: string) => boolean;
}

export interface GuardrailMatch {
  ruleId: string;
  description: string;
  severity: GuardrailRule["severity"];
  command: string;
}

// A "segment" is the stretch of a shell command between pipes/separators.
// `[^|;&]*` keeps a match from bleeding across `git status && rm -rf x`
// into a false git-related classification, while still matching each
// segment on its own.
const SEG = "[^|;&\\n]*";
// End-of-word that also rejects a hyphen, so `commit` doesn't match `commit-tree`
// and `push` doesn't match `push-notification`.
const W = "(?![\\w-])";

const re = (source: string, flags = "i") => new RegExp(source, flags);

export const DEFAULT_GUARDRAIL_RULES: GuardrailRule[] = [
  {
    id: "git-force-push",
    description: "Force-push (rewrites the remote branch)",
    severity: "critical",
    test: (c) =>
      re(`\\bgit\\b${SEG}\\bpush${W}${SEG}(--force(-with-lease|-if-includes)?\\b|\\s-[a-zA-Z]*f[a-zA-Z]*\\b)`).test(c) ||
      // `git push origin +branch` is also a force push.
      re(`\\bgit\\b${SEG}\\bpush${W}${SEG}\\s\\+\\S+`).test(c),
  },
  {
    id: "git-push",
    description: "Push to a remote",
    severity: "confirm",
    test: (c) => re(`\\bgit\\b${SEG}\\bpush${W}`).test(c),
  },
  {
    id: "git-history-rewrite",
    description: "Rewrite git history (amend / rebase / filter-branch / filter-repo / replace)",
    severity: "critical",
    test: (c) =>
      re(`\\bgit\\b${SEG}\\bcommit${W}${SEG}--amend\\b`).test(c) ||
      re(`\\bgit\\b${SEG}\\b(rebase|filter-branch|filter-repo|replace)${W}`).test(c),
  },
  {
    id: "git-commit",
    description: "Create a git commit",
    severity: "confirm",
    test: (c) => re(`\\bgit\\b${SEG}\\bcommit${W}`).test(c),
  },
  {
    id: "git-reset-hard",
    description: "Hard reset (discards working tree changes)",
    severity: "critical",
    test: (c) => re(`\\bgit\\b${SEG}\\breset${W}${SEG}--hard\\b`).test(c),
  },
  {
    id: "recursive-delete",
    description: "Recursive delete",
    severity: "critical",
    test: (c) =>
      // rm followed (within the same segment) by a flag cluster containing r/R, or --recursive
      re(`(^|[|;&\\s])rm(\\s+[^\\s|;&]+)*\\s+-[a-zA-Z]*[rR][a-zA-Z]*\\b`).test(c) ||
      re(`(^|[|;&\\s])rm(\\s+[^\\s|;&]+)*\\s+--recursive\\b`).test(c) ||
      // Windows / PowerShell equivalents, since friends run this cross-platform
      re(`\\b(rmdir|rd)(\\s+[^\\s|;&]+)*\\s+/s\\b`).test(c) ||
      re(`\\bRemove-Item\\b${SEG}-Recurse\\b`).test(c),
  },
  {
    id: "open-pull-request",
    description: "Open a pull / merge request on the forge",
    severity: "confirm",
    test: (c) =>
      re(`\\bgh\\s+pr\\s+create\\b`).test(c) ||
      re(`\\bglab\\s+mr\\s+create\\b`).test(c) ||
      re(`\\bhub\\s+pull-request\\b`).test(c),
  },
  {
    // Anything else that writes to the forge is just as outward-facing as a
    // PR: an issue, a comment, a review, a fork, a release, or a raw API
    // call that creates or changes something. Read-only gh/glab (list,
    // view, status, search, checkout, GET api) stays free.
    id: "forge-write",
    description: "Write to the forge (issue, comment, review, fork, release, or API call that creates or changes something public)",
    severity: "confirm",
    test: (c) =>
      re(`\\bgh\\s+issue\\s+(create|comment|edit|close|reopen|delete|transfer|pin|unpin|lock|unlock|develop)${W}`).test(c) ||
      re(`\\bgh\\s+pr\\s+(comment|review|merge|close|reopen|edit|ready|lock|unlock|update-branch)${W}`).test(c) ||
      re(`\\bgh\\s+repo\\s+(fork|create|delete|archive|unarchive|edit|rename|sync|set-default)${W}`).test(c) ||
      re(`\\bgh\\s+(release|gist|label)\\s+(create|edit|delete|upload)${W}`).test(c) ||
      // gh api: an explicit write method, or fields/input (which make gh default to POST)
      re(`\\bgh\\s+api\\b${SEG}(-X|--method)[\\s=]+(POST|PUT|PATCH|DELETE)\\b`).test(c) ||
      re(`\\bgh\\s+api\\b${SEG}\\s(-f|-F|--field|--raw-field|--input)${W}`).test(c) ||
      re(`\\bglab\\s+issue\\s+(create|note|comment|close|reopen|update|delete)${W}`).test(c) ||
      re(`\\bglab\\s+mr\\s+(note|comment|approve|merge|close|reopen|update|delete)${W}`).test(c) ||
      re(`\\bglab\\s+repo\\s+(fork|create|delete)${W}`).test(c),
  },
];

/**
 * Returns the first matching rule, or null. Rule order matters: the more
 * specific/critical variant of a command family is listed before the
 * general one (force-push before push, amend before commit) so the UI
 * gets the sharper description.
 */
export function matchGuardrail(
  command: string,
  rules: GuardrailRule[] = DEFAULT_GUARDRAIL_RULES
): GuardrailMatch | null {
  if (!command) return null;
  for (const rule of rules) {
    if (rule.test(command)) {
      return { ruleId: rule.id, description: rule.description, severity: rule.severity, command };
    }
  }
  return null;
}

/** Pulls the command string out of a Bash tool input, tolerating odd shapes. */
export function commandFromToolInput(input: unknown): string {
  if (input && typeof input === "object" && "command" in input) {
    const c = (input as { command?: unknown }).command;
    return typeof c === "string" ? c : "";
  }
  return "";
}
