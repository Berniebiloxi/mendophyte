import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { run } from "../orchestrator/preflight/run.js";
import os from "node:os";
import path from "node:path";
import { listArtifactHome, type ArtifactEntry } from "../orchestrator/preflight/local.js";

import {
  ApprovalBroker,
  QuestionBroker,
  type QuestionAnswers,
  type QuestionRequest,
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
  /** AskUserQuestion calls waiting for the user in the UI. */
  pendingQuestions: number;
  /** True from a message being sent until the turn's result arrives: the agent is working. */
  busy: boolean;
  /** Wall-clock and API time of the last completed turn, for the latency readout. */
  lastTurn: TurnTiming | null;
  /**
   * The phase the agent is working in right now, inferred from it reading
   * prompts/0N-*.md. The structured state only arrives when a turn ends, and
   * one turn can run through several phases when the agent asks questions
   * with AskUserQuestion (which keeps the turn open), so the tree would
   * otherwise sit at "waiting" for many minutes.
   */
  livePhase: number | null;
  lastError: string | null;
  preflight: PreflightSummary | null;
}

export interface TurnTiming {
  /** From the user's message (or kickoff) to the turn's result. */
  wallMs: number;
  /** Time the model API itself took, as reported by Claude Code. */
  apiMs: number | null;
  /** From the message to the first streamed text. */
  firstTextMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
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
  | "user_text"
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

export interface QuestionView extends QuestionRequest {
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
  /** Accept a directory that is not a git repository (the meta-prompt assumes a clone; tests and odd cases only). */
  allowNonGit?: boolean;
}

export interface ManagerEvents {
  "session.created": (s: SessionSummary) => void;
  "session.updated": (s: SessionSummary) => void;
  "session.removed": (id: string) => void;
  "session.event": (e: SessionEvent) => void;
  "approval.pending": (a: ApprovalView) => void;
  "approval.resolved": (a: ApprovalView, decision: ApprovalDecision) => void;
  "question.pending": (q: QuestionView) => void;
  "question.resolved": (q: QuestionView, answered: boolean) => void;
  /** The assistant's reply so far, streamed; not buffered, "" when the reply is complete. */
  "session.draft": (sessionId: string, text: string) => void;
}

interface Entry {
  summary: SessionSummary;
  session: SessionLike;
  broker: ApprovalBroker;
  questions: QuestionBroker;
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
  turnStartedAt: number | null;
  firstTextAt: number | null;
  /** Claude Code's cumulative session totals as of the previous result, to derive per-turn numbers. */
  prevApiMs: number;
  prevDurationMs: number;
  draft: string;
  draftTimer: NodeJS.Timeout | null;
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

  pendingQuestions(): QuestionView[] {
    const out: QuestionView[] = [];
    for (const [id, e] of this.entries) for (const q of e.questions.pending()) out.push({ ...q, sessionId: id });
    return out;
  }

  answerQuestion(questionId: string, answers: QuestionAnswers): boolean {
    for (const e of this.entries.values()) if (e.questions.answer(questionId, answers)) return true;
    return false;
  }

  dismissQuestion(questionId: string, reason?: string): boolean {
    for (const e of this.entries.values()) if (e.questions.dismiss(questionId, reason)) return true;
    return false;
  }

  async create(input: CreateSessionInput): Promise<SessionSummary> {
    const repoDir = path.resolve(input.repoDir);
    await assertRepoDir(repoDir, input.allowNonGit);
    const model = normalizeModel(input.model);
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
    const questions = new QuestionBroker();
    const config: SessionConfig = {
      repoDir,
      artifactHome,
      promptDir,
      approvals: broker,
      questions,
      model,
      maxTurns: input.maxTurns,
    };
    const session = this.factory(config);

    const summary: SessionSummary = {
      id,
      repoDir,
      artifactHome,
      repoUrl,
      model: model ?? null,
      sdkSessionId: null,
      status: "starting",
      createdAt: new Date().toISOString(),
      lastState: null,
      lastTriage: null,
      pendingApprovals: 0,
      pendingQuestions: 0,
      busy: false,
      lastTurn: null,
      livePhase: null,
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
    const entry: Entry = { summary, session, broker, questions, turnStartedAt: null, firstTextAt: null, prevApiMs: 0, prevDurationMs: 0, draft: "", draftTimer: null, events: [], seq: 0, preflightFacts: facts, report, fragility: null, verificationDetected: null, verificationRuns: [], watcher: null, watchTimer: null, submission: null, submissionTimer: null, submissionIntervalSec: null, submissionBusy: false };
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

    if (input.kickoff) this.startTurn(entry, input.kickoff, true);
    else if (!input.noKickoff) this.startTurn(entry, buildKickoffMessage({ repoUrl: repoUrl ?? undefined, facts: facts ?? undefined }), true);

    return summary;
  }

  send(id: string, text: string): void {
    this.startTurn(this.mustGet(id), text, false);
  }

  /** Sends a message and marks the session busy until the result comes back. */
  private startTurn(entry: Entry, text: string, kickoff: boolean): void {
    entry.turnStartedAt = Date.now();
    entry.firstTextAt = null;
    entry.summary.busy = true;
    this.record(entry, "user_text", { text, kickoff });
    this.emit("session.updated", entry.summary);
    entry.session.send(text);
  }

  private pushDraft(entry: Entry, flush = false): void {
    if (entry.draftTimer && !flush) return;
    const fire = () => {
      entry.draftTimer = null;
      this.emit("session.draft", entry.summary.id, entry.draft);
    };
    if (flush) {
      if (entry.draftTimer) clearTimeout(entry.draftTimer);
      fire();
    } else entry.draftTimer = setTimeout(fire, 80);
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
    e.questions.dismissAll("Session removed.");
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

  mustGet(id: string): Entry {
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
    const { session, broker, questions, summary } = entry;
    const updated = () => this.emit("session.updated", summary);

    session.on("init", (info: { sessionId: string; model: string; permissionMode: string; tools: string[] }) => {
      summary.sdkSessionId = info.sessionId;
      summary.status = "running";
      if (!summary.model) summary.model = info.model;
      this.record(entry, "init", info);
      updated();
    });
    session.on("assistant_delta", (text: string) => {
      if (entry.firstTextAt === null) entry.firstTextAt = Date.now();
      entry.draft += text;
      this.pushDraft(entry);
    });
    session.on("assistant_text", (text: string) => {
      if (entry.firstTextAt === null) entry.firstTextAt = Date.now();
      entry.draft = "";
      this.pushDraft(entry, true);
      this.record(entry, "assistant_text", { text });
      // Claude Code reports a bad model choice as an assistant message and ends the
      // turn at zero cost; make it a visible session error rather than chat to read.
      if (/issue with the selected model/i.test(text)) {
        summary.lastError = `${text.trim()} Set the model to sonnet, opus or haiku (no slash), or leave it blank for your Claude Code default, then start a new session.`;
        updated();
      }
    });
    session.on("tool_use", (t: { name: string; input: unknown; id: string }) => {
      this.record(entry, "tool_use", t);
      if (t.name === "Read") {
        const p = String((t.input as { file_path?: string })?.file_path ?? "").replace(/\\/g, "/");
        const m = /\/0([0-5])-(entry|recon|orientation|triage|fix|submission)\.md$/.exec(p);
        if (m) {
          const ph = Number(m[1]);
          if (summary.livePhase === null || ph > summary.livePhase) {
            summary.livePhase = ph;
            updated();
          }
        }
      }
    });
    session.on("tool_allowed", (t: { toolName: string; input: Record<string, unknown> }) => this.record(entry, "tool_allowed", t));
    session.on("state", (s: SessionState) => {
      summary.lastState = s;
      if (summary.livePhase === null || s.phase > summary.livePhase) summary.livePhase = s.phase;
      if (s.triage) summary.lastTriage = s.triage;
      this.record(entry, "state", s);
      updated();
    });
    session.on("turn", ({ result, state, stateError }: TurnEvent) => {
      const r = result as Record<string, unknown>;
      const now = Date.now();
      // Claude Code's duration_api_ms / duration_ms are cumulative for the whole session
      // (verified from a real log: 636s, 668s, 742s… across consecutive turns), so per-turn
      // API time is the difference from the previous result.
      const cumApi = typeof r.duration_api_ms === "number" ? r.duration_api_ms : null;
      const apiMs = cumApi === null ? null : Math.max(0, cumApi - entry.prevApiMs);
      if (cumApi !== null) entry.prevApiMs = cumApi;
      if (typeof r.duration_ms === "number") entry.prevDurationMs = r.duration_ms;
      const timing: TurnTiming | null = entry.turnStartedAt
        ? {
            wallMs: now - entry.turnStartedAt,
            apiMs,
            firstTextMs: entry.firstTextAt ? entry.firstTextAt - entry.turnStartedAt : null,
            numTurns: typeof result.num_turns === "number" ? result.num_turns : null,
            costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
          }
        : null;
      entry.turnStartedAt = null;
      entry.draft = "";
      this.pushDraft(entry, true);
      summary.busy = false;
      summary.lastTurn = timing;
      this.record(entry, "turn", {
        subtype: result.subtype,
        is_error: result.is_error,
        num_turns: result.num_turns,
        total_cost_usd: r.total_cost_usd ?? null,
        duration_ms: r.duration_ms ?? null,
        duration_api_ms: r.duration_api_ms ?? null,
        timing,
        session_id: result.session_id,
        state,
        stateError: stateError ?? null,
      });
      updated();
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
      summary.busy = false;
      summary.lastError = e.message;
      this.record(entry, "error", { message: e.message });
      updated();
    });
    session.on("end", () => {
      if (summary.status !== "error") summary.status = "ended";
      summary.busy = false;
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
    questions.on("pending", (req: QuestionRequest) => {
      summary.pendingQuestions = questions.pending().length;
      this.emit("question.pending", { ...req, sessionId: summary.id });
      updated();
    });
    questions.on("resolved", (req: QuestionRequest, d: { answered: boolean }) => {
      summary.pendingQuestions = questions.pending().length;
      this.emit("question.resolved", { ...req, sessionId: summary.id }, d.answered);
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
export class ValidationError extends Error {}

/** Known Claude Code model aliases; anything else is passed through as a full model id. */
const MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable", "default"];

/**
 * People type models the way Claude Code's slash command shows them
 * ("/Sonnet", " Opus"). Claude Code wants the bare alias or a full id.
 */
export function normalizeModel(input: string | undefined | null): string | undefined {
  if (input == null) return undefined;
  let m = String(input).trim().replace(/^\/+/, "").trim();
  if (!m) return undefined;
  if (/^model\s+/i.test(m)) m = m.replace(/^model\s+/i, "").trim();
  const lower = m.toLowerCase();
  if (MODEL_ALIASES.includes(lower)) return lower === "default" ? undefined : lower;
  return m;
}

async function assertRepoDir(repoDir: string, allowNonGit?: boolean): Promise<void> {
  let st;
  try {
    st = await stat(repoDir);
  } catch {
    throw new ValidationError(`${repoDir} does not exist. Paste the absolute path of your local clone of the target project.`);
  }
  if (!st.isDirectory()) throw new ValidationError(`${repoDir} is not a directory.`);
  if (allowNonGit) return;
  const r = await run("git", ["rev-parse", "--show-toplevel"], { cwd: repoDir, timeoutMs: 10_000 });
  if (!r.ok) {
    throw new ValidationError(`${repoDir} is not a git repository. Mendophyte works on a local clone of the project you want to contribute to (run \`git clone <url>\` first, then point it at that directory).`);
  }
  // Compare real paths: macOS temp dirs are symlinks (/var -> /private/var) and
  // git prints forward slashes on Windows, so a string comparison misfires.
  const top = r.stdout.trim();
  if (top) {
    const [a, b] = await Promise.all([realpath(repoDir).catch(() => repoDir), realpath(path.resolve(top)).catch(() => path.resolve(top))]);
    const same = process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!same) throw new ValidationError(`${repoDir} is inside the repository ${top}; use the repository root.`);
  }
}
