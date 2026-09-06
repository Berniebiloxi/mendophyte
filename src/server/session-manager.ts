import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listArtifactHome, type ArtifactEntry } from "../orchestrator/preflight/local.js";

import {
  ApprovalBroker,
  MendophyteSession,
  buildKickoffMessage,
  defaultPromptDir,
  formatPreflightFacts,
  runPreflight,
  type ApprovalDecision,
  type ApprovalRequest,
  type DetectionReport,
  type FragilityReport,
  type PreflightReport,
  type VerificationProgress,
  type VerificationRun,
  computeSubmission,
  type BenchRun,
  type FeedbackLog,
  type SessionConfig,
  type SessionState,
  type SubmissionReport,
  type Triage,
  type TurnEvent,
} from "../orchestrator/index.js";

/**
 * Owns every live session behind the local server and turns their events
 * into a single, sequenced stream the websocket hub can broadcast and a
 * late-joining client can replay. No transport here: routes.ts and ws.ts
 * are the only things that know about HTTP or sockets.
 */

/** The subset of MendophyteSession the manager relies on; tests inject fakes. */
export interface SessionLike extends EventEmitter {
  readonly sessionId: string | null;
  readonly lastState: SessionState | null;
  start(): Promise<void>;
  send(text: string): void;
  interrupt(): Promise<void>;
  end(): void;
  close(): void;
}

export type SessionFactory = (config: SessionConfig) => SessionLike;

export type SessionStatus = "starting" | "running" | "ended" | "error";

export interface SessionSummary {
  id: string;
  repoDir: string;
  artifactHome: string;
  repoUrl: string | null;
  model: string | null;
  sdkSessionId: string | null;
  status: SessionStatus;
  createdAt: string;
  lastState: SessionState | null;
  /** The most recent structured state that carried triage, kept after the phase moves on. */
  lastTriage: Triage | null;
  pendingApprovals: number;
  lastError: string | null;
  preflight: PreflightSummary | null;
}

export interface PreflightSummary {
  tier: PreflightReport["capability"]["tier"];
  forgeUrl: string | null;
  health: PreflightReport["health"];
  policyFiles: number;
  artifactsPresent: number;
}

export type SessionEventName =
  | "init"
  | "assistant_text"
  | "tool_use"
  | "tool_allowed"
  | "turn"
  | "state"
  | "fragility"
  | "verification_detected"
  | "verification_progress"
  | "verification"
  | "artifacts"
  | "submission"
  | "feedback_log"
  | "benchmark"
  | "message"
  | "error"
  | "end";

export interface SessionEvent {
  seq: number;
  at: string;
  sessionId: string;
  event: SessionEventName;
  data: unknown;
}

export interface ApprovalView extends ApprovalRequest {
  sessionId: string;
}

export interface CreateSessionInput {
  repoDir: string;
  artifactHome?: string;
  repoUrl?: string;
  model?: string;
  maxTurns?: number;
  /** Run the deterministic Phase 0 checks and hand them over in the kickoff. Default true. */
  preflight?: boolean;
  /** Replace the standard kickoff message entirely (tests, scripted runs). */
  kickoff?: string;
  /** Start the session but send nothing. */
  noKickoff?: boolean;
  promptDir?: string;
}

export interface ManagerEvents {
  "session.created": (s: SessionSummary) => void;
  "session.updated": (s: SessionSummary) => void;
  "session.removed": (id: string) => void;
  "session.event": (e: SessionEvent) => void;
  "approval.pending": (a: ApprovalView) => void;
  "approval.resolved": (a: ApprovalView, decision: ApprovalDecision) => void;
}

interface Entry {
  summary: SessionSummary;
  session: SessionLike;
  broker: ApprovalBroker;
  events: SessionEvent[];
  seq: number;
  preflightFacts: string | null;
  report: PreflightReport | null;
  /** Latest whole-repo fragility report, from the agent's tool call or the UI's request. */
  fragility: FragilityReport | null;
  verificationDetected: DetectionReport | null;
  /** Newest first, capped. */
  verificationRuns: VerificationRun[];
  watcher: FSWatcher | null;
  watchTimer: NodeJS.Timeout | null;
  submission: SubmissionReport | null;
  submissionTimer: NodeJS.Timeout | null;
  submissionIntervalSec: number | null;
  submissionBusy: boolean;
}

export const VERIFICATION_HISTORY = 20;

export const EVENT_BUFFER = 500;

export function defaultArtifactHome(repoDir: string): string {
  return path.join(os.homedir(), ".mendophyte", path.basename(repoDir));
}

export class SessionManager extends EventEmitter {
  private entries = new Map<string, Entry>();
  private readonly factory: SessionFactory;

  constructor(opts: { factory?: SessionFactory } = {}) {
    super();
    this.factory = opts.factory ?? ((config) => new MendophyteSession(config));
  }

  list(): SessionSummary[] {
    return [...this.entries.values()].map((e) => e.summary);
  }

  get(id: string): SessionSummary | undefined {
    return this.entries.get(id)?.summary;
  }

  /** Events since `afterSeq` (exclusive) for one session, from the ring buffer. */
  events(id: string, afterSeq = 0): SessionEvent[] {
    const e = this.entries.get(id);
    return e ? e.events.filter((ev) => ev.seq > afterSeq) : [];
  }

  preflightFor(id: string): { report: PreflightReport | null; facts: string | null } {
    const e = this.entries.get(id);
    return { report: e?.report ?? null, facts: e?.preflightFacts ?? null };
  }

  fragilityFor(id: string): FragilityReport | null {
    return this.entries.get(id)?.fragility ?? null;
  }

  setFragility(id: string, report: FragilityReport): void {
    const e = this.entries.get(id);
    if (e) e.fragility = report;
  }

  verificationFor(id: string): { detected: DetectionReport | null; runs: VerificationRun[] } {
    const e = this.entries.get(id);
    return { detected: e?.verificationDetected ?? null, runs: e?.verificationRuns ?? [] };
  }

  /** Records a run started by the UI (not the agent) so both paths land in the same history and event stream. */
  recordVerification(id: string, run: VerificationRun): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.verificationRuns.unshift(run);
    if (e.verificationRuns.length > VERIFICATION_HISTORY) e.verificationRuns.length = VERIFICATION_HISTORY;
    this.record(e, "verification", run);
  }

  recordVerificationDetected(id: string, d: DetectionReport): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.verificationDetected = d;
    this.record(e, "verification_detected", d);
  }

  recordVerificationProgress(id: string, p: VerificationProgress): void {
    const e = this.entries.get(id);
    if (e) this.record(e, "verification_progress", p);
  }

  // ---- submission (Phase 5): report + forge polling on a timer

  submissionFor(id: string): { report: SubmissionReport | null; pollingSec: number | null } {
    const e = this.entries.get(id);
    return { report: e?.submission ?? null, pollingSec: e?.submissionIntervalSec ?? null };
  }

  /** Recomputes the submission report and streams it as a `submission` event. Overlapping calls coalesce. */
  async refreshSubmission(id: string, opts: { fetch?: boolean } = {}): Promise<SubmissionReport> {
    const e = this.mustGet(id);
    if (e.submissionBusy && e.submission && !opts.fetch) return e.submission;
    e.submissionBusy = true;
    try {
      const report = await computeSubmission({ repoDir: e.summary.repoDir, artifactHome: e.summary.artifactHome, fetch: opts.fetch });
      this.recordSubmission(id, report);
      return report;
    } finally {
      e.submissionBusy = false;
    }
  }

  recordBenchmark(id: string, run: BenchRun): void {
    const e = this.entries.get(id);
    if (e) this.record(e, "benchmark", run);
  }

  recordFeedbackLog(id: string, log: FeedbackLog): void {
    const e = this.entries.get(id);
    if (e) this.record(e, "feedback_log", log);
  }

  recordSubmission(id: string, report: SubmissionReport): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.submission = report;
    this.record(e, "submission", report);
  }

  /** Starts (or changes) polling; `null` stops it. Minimum 15 seconds to stay friendly to anonymous rate limits. */
  setSubmissionPolling(id: string, intervalSec: number | null): void {
    const e = this.mustGet(id);
    if (e.submissionTimer) clearInterval(e.submissionTimer);
    e.submissionTimer = null;
    e.submissionIntervalSec = null;
    if (intervalSec === null) {
      this.emit("session.updated", e.summary);
      return;
    }
    const sec = Math.max(15, Math.min(3600, Math.round(intervalSec)));
    e.submissionIntervalSec = sec;
    e.submissionTimer = setInterval(() => {
      void this.refreshSubmission(id).catch(() => {});
    }, sec * 1000);
    e.submissionTimer.unref?.();
    void this.refreshSubmission(id).catch(() => {});
  }

  pendingApprovals(): ApprovalView[] {
    const out: ApprovalView[] = [];
    for (const [id, e] of this.entries) for (const a of e.broker.pending()) out.push({ ...a, sessionId: id });
    return out;
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
    for (const e of this.entries.values()) if (e.broker.resolve(approvalId, decision)) return true;
    return false;
  }

  async create(input: CreateSessionInput): Promise<SessionSummary> {
    const repoDir = path.resolve(input.repoDir);
    const artifactHome = path.resolve(input.artifactHome ?? defaultArtifactHome(repoDir));
    await mkdir(artifactHome, { recursive: true });
    const promptDir = input.promptDir ?? defaultPromptDir();
    const id = randomUUID();

    let report: PreflightReport | null = null;
    let facts: string | null = null;
    let repoUrl = input.repoUrl ?? null;
    if (input.preflight !== false && !input.kickoff && !input.noKickoff) {
      report = await runPreflight({ repoDir, artifactHome, repoUrl: input.repoUrl });
      facts = formatPreflightFacts(report);
      repoUrl ??= report.capability.forge?.webUrl ?? null;
    }

    const broker = new ApprovalBroker();
    const config: SessionConfig = {
      repoDir,
      artifactHome,
      promptDir,
      approvals: broker,
      model: input.model,
      maxTurns: input.maxTurns,
    };
    const session = this.factory(config);

    const summary: SessionSummary = {
      id,
      repoDir,
      artifactHome,
      repoUrl,
      model: input.model ?? null,
      sdkSessionId: null,
      status: "starting",
      createdAt: new Date().toISOString(),
      lastState: null,
      lastTriage: null,
      pendingApprovals: 0,
      lastError: null,
      preflight: report
        ? {
            tier: report.capability.tier,
            forgeUrl: report.capability.forge?.webUrl ?? null,
            health: report.health,
            policyFiles: report.policy.files.length,
            artifactsPresent: report.artifacts.entries.length,
          }
        : null,
    };
    const entry: Entry = { summary, session, broker, events: [], seq: 0, preflightFacts: facts, report, fragility: null, verificationDetected: null, verificationRuns: [], watcher: null, watchTimer: null, submission: null, submissionTimer: null, submissionIntervalSec: null, submissionBusy: false };
    this.entries.set(id, entry);
    this.wire(entry);
    this.watchArtifacts(entry);
    this.emit("session.created", summary);

    try {
      await session.start();
    } catch (e) {
      summary.status = "error";
      summary.lastError = e instanceof Error ? e.message : String(e);
      this.emit("session.updated", summary);
      throw e;
    }

    if (input.kickoff) session.send(input.kickoff);
    else if (!input.noKickoff) session.send(buildKickoffMessage({ repoUrl: repoUrl ?? undefined, facts: facts ?? undefined }));

    return summary;
  }

  send(id: string, text: string): void {
    this.mustGet(id).session.send(text);
  }

  async interrupt(id: string): Promise<void> {
    await this.mustGet(id).session.interrupt();
  }

  end(id: string): void {
    this.mustGet(id).session.end();
  }

  /** Force-closes the session and forgets it. */
  remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    e.watcher?.close();
    if (e.watchTimer) clearTimeout(e.watchTimer);
    if (e.submissionTimer) clearInterval(e.submissionTimer);
    e.session.close();
    e.broker.denyAll("Session removed.");
    this.entries.delete(id);
    this.emit("session.removed", id);
    return true;
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  // ---- internals -------------------------------------------------------

  /**
   * Watches the artifact home (top level, where Artifacts A-F live) and
   * emits an `artifacts` event with the fresh listing, debounced, so the
   * spine's buds and the artifact viewers update as the agent writes.
   */
  private watchArtifacts(entry: Entry): void {
    try {
      entry.watcher = watch(entry.summary.artifactHome, { persistent: false }, () => {
        if (entry.watchTimer) clearTimeout(entry.watchTimer);
        entry.watchTimer = setTimeout(() => {
          entry.watchTimer = null;
          void this.emitArtifacts(entry);
        }, 250);
      });
      entry.watcher.on("error", () => {
        entry.watcher?.close();
        entry.watcher = null;
      });
    } catch {
      entry.watcher = null; // unwatchable filesystem; the UI falls back to polling after turns
    }
  }

  private async emitArtifacts(entry: Entry): Promise<void> {
    const listing = await listArtifactHome(entry.summary.artifactHome);
    const payload: { artifactHome: string; exists: boolean; entries: ArtifactEntry[] } = { artifactHome: entry.summary.artifactHome, ...listing };
    this.record(entry, "artifacts", payload);
  }

  private mustGet(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new NotFoundError(`No session ${id}`);
    return e;
  }

  private record(entry: Entry, event: SessionEventName, data: unknown): void {
    const ev: SessionEvent = {
      seq: ++entry.seq,
      at: new Date().toISOString(),
      sessionId: entry.summary.id,
      event,
      data,
    };
    entry.events.push(ev);
    if (entry.events.length > EVENT_BUFFER) entry.events.splice(0, entry.events.length - EVENT_BUFFER);
    this.emit("session.event", ev);
  }

  private wire(entry: Entry): void {
    const { session, broker, summary } = entry;
    const updated = () => this.emit("session.updated", summary);

    session.on("init", (info: { sessionId: string; model: string; permissionMode: string; tools: string[] }) => {
      summary.sdkSessionId = info.sessionId;
      summary.status = "running";
      if (!summary.model) summary.model = info.model;
      this.record(entry, "init", info);
      updated();
    });
    session.on("assistant_text", (text: string) => this.record(entry, "assistant_text", { text }));
    session.on("tool_use", (t: { name: string; input: unknown; id: string }) => this.record(entry, "tool_use", t));
    session.on("tool_allowed", (t: { toolName: string; input: Record<string, unknown> }) => this.record(entry, "tool_allowed", t));
    session.on("state", (s: SessionState) => {
      summary.lastState = s;
      if (s.triage) summary.lastTriage = s.triage;
      this.record(entry, "state", s);
      updated();
    });
    session.on("turn", ({ result, state, stateError }: TurnEvent) => {
      const r = result as Record<string, unknown>;
      this.record(entry, "turn", {
        subtype: result.subtype,
        is_error: result.is_error,
        num_turns: result.num_turns,
        total_cost_usd: r.total_cost_usd ?? null,
        session_id: result.session_id,
        state,
        stateError: stateError ?? null,
      });
    });
    session.on("fragility", (r: FragilityReport) => {
      // Only whole-repo reports serve as the overlay's default; narrowed ones are still streamed.
      if (!r.subpath) entry.fragility = r;
      this.record(entry, "fragility", { subpath: r.subpath, window: r.window, trackedFiles: r.trackedFiles, topChurn: r.top.churn.slice(0, 5).map((f) => f.path) });
    });
    session.on("verification_detected", (d: DetectionReport) => this.recordVerificationDetected(summary.id, d));
    session.on("verification_progress", (p: VerificationProgress) => this.recordVerificationProgress(summary.id, p));
    session.on("verification", (run: VerificationRun) => this.recordVerification(summary.id, run));
    session.on("submission", (r: SubmissionReport) => this.recordSubmission(summary.id, r));
    session.on("feedback_log", (l: FeedbackLog) => this.recordFeedbackLog(summary.id, l));
    session.on("benchmark", (b: BenchRun) => this.recordBenchmark(summary.id, b));
    session.on("message", (m: unknown) => this.record(entry, "message", m));
    session.on("error", (e: Error) => {
      summary.status = "error";
      summary.lastError = e.message;
      this.record(entry, "error", { message: e.message });
      updated();
    });
    session.on("end", () => {
      if (summary.status !== "error") summary.status = "ended";
      this.record(entry, "end", null);
      updated();
    });

    broker.on("pending", (req) => {
      summary.pendingApprovals = broker.pending().length;
      this.emit("approval.pending", { ...req, sessionId: summary.id });
      updated();
    });
    broker.on("resolved", (req, decision) => {
      summary.pendingApprovals = broker.pending().length;
      this.emit("approval.resolved", { ...req, sessionId: summary.id }, decision);
      updated();
    });
  }

  override on<E extends keyof ManagerEvents>(event: E, listener: ManagerEvents[E]): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
  override off<E extends keyof ManagerEvents>(event: E, listener: ManagerEvents[E]): this;
  override off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}

export class NotFoundError extends Error {}
