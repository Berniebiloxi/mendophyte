import { z } from "zod";

/**
 * Structured-output schema for the dashboard state.
 *
 * Resolution of the handoff's open question (schema-per-call vs. per-phase):
 * `outputFormat` is a `query()` option. In the installed SDK (0.3.263)
 * there is no control request to change it mid-session, so the schema is
 * fixed for the lifetime of one streaming-input `query()` call. Each turn
 * in that session still yields its own `result` message carrying a
 * `structured_output` validated against that one schema (verified by the
 * live integration test).
 *
 * Consequence: one long-lived session per workflow, with ONE schema that
 * covers every phase. Phase-specific detail (triage cards, danger gauge,
 * verification checklist) is added later as optional fields on this same
 * object, never as a per-phase schema swap. Keep every non-universal field
 * optional so early phases can validate without inventing values.
 */

export const PHASES = [0, 1, 2, 3, 4, 5] as const;

export const YourTurnKind = z.enum([
  // Phase 0 entry questions and any other direct question to the user
  "answer_question",
  // Phase 3 shallow pass: user picks which ranked candidate to take into the deep pass
  "choose_candidate",
  // Phase 4 step 1: user states a hypothesis before the agent confirms/refutes
  "state_hypothesis",
  // "How This Splits Between Us": user finds the exact line themselves
  "locate_line",
  // User states what they think the fix is; unlocks showing a diff
  "state_fix",
  // Some/Experienced: user writes the failing test or benchmark first
  "write_test",
  // Some/Experienced: user drafts the PR description first
  "draft_pr_description",
  // None tier: user explains back why the fix is safe before PR goes out
  "explain_back",
  // Standing guardrails: an explicit go-ahead the agent is waiting for
  "confirm_go_ahead",
  // Resume check: confirm how to proceed given what changed
  "confirm_resume",
  "other",
]);

export const YourTurnItem = z.object({
  id: z
    .string()
    .describe("Short stable slug for this item, reused if the same item is re-emitted on a later turn."),
  kind: YourTurnKind,
  prompt: z
    .string()
    .describe("What the user is being asked to do or answer, in one or two sentences, as it should appear in the queue."),
  blocks: z
    .enum(["none", "diff", "pr_draft", "commit", "push"])
    .describe(
      "What stays locked in the UI until this item is submitted. 'diff' for anything that must precede showing a code change; 'pr_draft' before the PR description is shown; 'none' otherwise."
    ),
});

// ---- Phase 3: the triage board ----------------------------------------
//
// Names mirror 03-triage.md exactly so the UI can show the criteria as
// tags/columns and the agent's Artifact B reads the same way. A score of
// "unobserved" is the honest value whenever the signal lives on the forge
// and the capability tier can't reach it.

export const BugCriterion = z.enum([
  "reproducibility",
  "staleness_or_claimed",
  "discussion_complexity",
  "bisectability",
  "environment_hardware_fit",
  "project_health",
  "maintainer_receptiveness",
  "root_cause_location",
  "determinism",
  "data_state_dependencies",
  "label_signal",
]);
export const PerfCriterion = z.enum([
  "profiling_signal",
  "baseline_measurability",
  "nondeterminism",
  "regression_safety",
  "hardware_criticality",
  "maintainer_receptiveness_perf",
]);
export const TriageCriterion = z.enum([...BugCriterion.options, ...PerfCriterion.options]);

export const CriterionScore = z.object({
  criterion: TriageCriterion,
  value: z.enum(["positive", "neutral", "negative", "unobserved"]).describe("positive helps the candidate, negative counts against it, unobserved means the forge data needed isn't reachable at this capability tier."),
  note: z.string().describe("One short clause of evidence, e.g. 'issue #42 has repro steps' or 'assignee set 3 days ago'. Empty string if none.").max(200),
});

export const TriageCandidate = z.object({
  id: z.string().describe("Short stable slug, e.g. 'issue-1234' or 'hot-parse-loop'."),
  rank: z.number().int().min(1),
  title: z.string(),
  source: z.string().describe("Issue/PR number or URL, or for performance work the profile hotspot; 'user-provided' if the user pasted it."),
  reason: z.string().describe("The one-line reason from the ranked list.").max(300),
  scores: z.array(CriterionScore).describe("One entry per criterion actually assessed. Use the bug criteria for a bug-fix session, the performance criteria for a performance session."),
});

export const DeepAssessment = z.object({
  candidate_id: z.string(),
  root_cause_in_repo: z.enum(["yes", "no", "unclear"]),
  reproducible_or_baseline: z.enum(["yes", "no", "not_yet"]).describe("Bug: can it be triggered reliably right now? Performance: is there a reliable baseline measurement?"),
  scope: z.enum(["one_function", "one_module", "cross_subproject"]),
  danger: z.enum(["contained", "ripples", "blast_radius"]).describe("Blast radius if this is subtly wrong. Phase 4 step 5's compatibility check may escalate this later; when it does, set escalated_by_compatibility."),
  danger_reason: z.string().max(300),
  doability: z.enum(["yes", "no", "conditional"]),
  doability_reason: z.string().max(300),
  time_to_first_build: z.enum(["ok", "slow", "blocked", "unknown"]).describe("Tracked separately from the fix's difficulty, per the task-level preflight."),
  escalated_by_compatibility: z.boolean(),
});

export const Triage = z.object({
  mode: z.enum(["shallow", "deep"]).describe("shallow while ranking candidates; deep once one is chosen and being assessed."),
  task_type: z.enum(["bug", "performance"]),
  candidates: z.array(TriageCandidate).describe("The 3-5 ranked candidates from the shallow pass. Keep them in deep mode so the user can go back to the list."),
  filtered_out: z.array(z.object({ title: z.string(), reason: z.string().max(200) })).describe("What got filtered out and why, as told to the user."),
  chosen: DeepAssessment.nullable().describe("The deep-pass assessment of the chosen task; null in shallow mode."),
  none_tractable: z.string().nullable().describe("If nothing looks like a safe, tractable starting point, the plain statement of that; otherwise null."),
});

export type Triage = z.infer<typeof Triage>;
export type TriageCandidate = z.infer<typeof TriageCandidate>;
export type DeepAssessment = z.infer<typeof DeepAssessment>;
export type CriterionScore = z.infer<typeof CriterionScore>;

export const SessionState = z.object({
  phase: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .describe("The phase whose file is currently open and being worked, 0-5."),
  phase_complete: z
    .boolean()
    .describe(
      "True only when the current phase's own completion condition is met and the next phase file has been read or is the next action. False while any step of the phase is still open."
    ),
  your_turn_items: z
    .array(YourTurnItem)
    .describe(
      "Everything currently waiting on the user, per 'How This Splits Between Us' and the Standing Guardrails. Empty when the agent can proceed without input. Never fold multiple distinct asks into one item."
    ),
  triage: Triage.optional().describe(
    "Phase 3 state for the triage board. Include it on every turn from the start of the shallow pass until Phase 4 begins (and again if the user bails out back to the candidate list). Scores must say the same thing as Artifact B. Omit in other phases."
  ),
});

export type SessionState = z.infer<typeof SessionState>;
export type YourTurnItem = z.infer<typeof YourTurnItem>;

/**
 * JSON Schema (draft-07, which is what the SDK validates against) for
 * `outputFormat`. Generated from the zod schema so the two can't drift.
 */
export const SESSION_STATE_JSON_SCHEMA = z.toJSONSchema(SessionState, {
  target: "draft-7",
}) as Record<string, unknown>;

/** Parses a raw `structured_output` value; returns null if it doesn't validate. */
export function parseSessionState(raw: unknown): { state: SessionState; error?: undefined } | { state?: undefined; error: string } {
  const r = SessionState.safeParse(raw);
  if (r.success) return { state: r.data };
  return { error: r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ") };
}
