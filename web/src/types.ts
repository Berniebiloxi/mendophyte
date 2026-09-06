// Type-only imports from the server: erased at build time, so the web
// bundle never pulls node modules in, but the wire format stays one source.
export type { SessionSummary, SessionEvent, SessionEventName, ApprovalView, SessionStatus } from "../../src/server/session-manager.js";
export type { SessionState, YourTurnItem, Triage, TriageCandidate, DeepAssessment, CriterionScore } from "../../src/orchestrator/schema.js";
export type { PreflightReport } from "../../src/orchestrator/preflight/index.js";
export type { FragilityReport } from "../../src/orchestrator/fragility/index.js";
export type { DetectionReport, VerificationRun, VerificationProgress, CheckResult } from "../../src/orchestrator/verification/index.js";
export type { DiffReport } from "../../src/orchestrator/git-diff.js";
export type { ArtifactEntry } from "../../src/orchestrator/preflight/local.js";
export type { FileEntry, FileListing, FileContent } from "../../src/orchestrator/files.js";
export type { TerminalInfo } from "../../src/server/terminals.js";
export type { SubmissionReport, CiStatus, CiCheck, TemplateItem } from "../../src/orchestrator/submission.js";
export type { FeedbackEntry, FeedbackLog } from "../../src/orchestrator/feedback-log.js";
export type { BenchRun, BenchSample, BenchDetection, BenchComparison } from "../../src/orchestrator/benchmark.js";

import type { SessionEvent } from "../../src/server/session-manager.js";

/** A message we sent, echoed locally so the conversation reads correctly before the agent replies. */
export interface LocalEvent {
  seq: number;
  at: string;
  sessionId: string;
  event: "user_text";
  data: { text: string };
}

export type AnyEvent = SessionEvent | LocalEvent;

export type ThemeName = "vine" | "minimal";
export type SchemeName = "auto" | "light" | "dark";
