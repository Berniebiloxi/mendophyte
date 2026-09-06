import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { GuardrailMatch } from "./guardrails.js";

/**
 * Pending-approval broker.
 *
 * `canUseTool` calls `request()` and awaits the returned promise; the
 * promise settles only when something calls `resolve()`. That "something"
 * is whatever front-end is attached: the dev CLI's y/n prompt today, a
 * websocket-driven confirm modal later. The broker is transport-agnostic
 * on purpose: it just emits `pending` and `resolved` events and keeps the
 * list of open requests so a late-connecting client can catch up.
 *
 * Fail-closed: if nobody is listening for `pending` when a request comes
 * in, it is denied immediately rather than hanging the agent forever.
 */

export interface ApprovalRequest {
  id: string;
  toolName: string;
  /** The tool input exactly as the agent proposed it. */
  input: Record<string, unknown>;
  /** For Bash, the command string; shown verbatim in the modal. */
  command: string;
  match: GuardrailMatch;
  cwd: string;
  createdAt: string;
}

export type ApprovalDecision =
  | { approved: true; decidedBy?: string }
  | { approved: false; reason?: string; decidedBy?: string };

export interface ApprovalEvents {
  pending: (req: ApprovalRequest) => void;
  resolved: (req: ApprovalRequest, decision: ApprovalDecision) => void;
}

export class ApprovalBroker extends EventEmitter {
  private open = new Map<
    string,
    { req: ApprovalRequest; settle: (d: ApprovalDecision) => void }
  >();

  /** Requests currently waiting on a human. */
  pending(): ApprovalRequest[] {
    return [...this.open.values()].map((e) => e.req);
  }

  /**
   * Registers a request and returns a promise for the decision.
   * `signal` is the SDK's abort signal for the tool call; if the query is
   * cancelled while we wait, the request is withdrawn and denied.
   */
  request(
    partial: Omit<ApprovalRequest, "id" | "createdAt">,
    signal?: AbortSignal
  ): Promise<ApprovalDecision> {
    const req: ApprovalRequest = {
      ...partial,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    if (this.listenerCount("pending") === 0) {
      const decision: ApprovalDecision = {
        approved: false,
        reason: "No approver is attached to this Mendophyte session, so the command was refused.",
        decidedBy: "broker",
      };
      queueMicrotask(() => this.emit("resolved", req, decision));
      return Promise.resolve(decision);
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (d: ApprovalDecision) => {
        if (!this.open.has(req.id)) return;
        this.open.delete(req.id);
        signal?.removeEventListener("abort", onAbort);
        this.emit("resolved", req, d);
        resolve(d);
      };
      const onAbort = () =>
        settle({ approved: false, reason: "The session was interrupted before a decision was made.", decidedBy: "abort" });

      this.open.set(req.id, { req, settle });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.emit("pending", req);
    });
  }

  /** Settles a pending request. Returns false if the id is unknown or already settled. */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const entry = this.open.get(id);
    if (!entry) return false;
    entry.settle(decision);
    return true;
  }

  /** Denies everything still open (e.g. on session close). */
  denyAll(reason = "Session closed."): void {
    for (const { settle } of [...this.open.values()]) {
      settle({ approved: false, reason, decidedBy: "broker" });
    }
  }

  override on<E extends keyof ApprovalEvents>(event: E, listener: ApprovalEvents[E]): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
  override once<E extends keyof ApprovalEvents>(event: E, listener: ApprovalEvents[E]): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }
}

// ---- AskUserQuestion routed to the UI --------------------------------------

/** One question as Claude Code's AskUserQuestion tool poses it. */
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

export interface QuestionRequest {
  id: string;
  questions: AskQuestion[];
  createdAt: string;
}

/** Answers keyed by question text; a free-text answer is just a string that isn't an option label. */
export type QuestionAnswers = Record<string, string | string[]>;

export type QuestionDecision = { answered: true; answers: QuestionAnswers } | { answered: false; reason?: string };

/**
 * Same shape as the approval broker, for the agent's clarifying questions:
 * the UI shows the options, the agent is blocked until the user answers.
 * Fail-closed: with nobody listening, the question is declined with a
 * message telling the agent to ask in prose instead.
 */
export class QuestionBroker extends EventEmitter {
  private open = new Map<string, { req: QuestionRequest; settle: (d: QuestionDecision) => void }>();

  pending(): QuestionRequest[] {
    return [...this.open.values()].map((e) => e.req);
  }

  request(questions: AskQuestion[], signal?: AbortSignal): Promise<QuestionDecision> {
    const req: QuestionRequest = { id: randomUUID(), questions, createdAt: new Date().toISOString() };
    if (this.listenerCount("pending") === 0) {
      const d: QuestionDecision = { answered: false, reason: "No UI is attached to answer questions; ask in prose and list the options in your reply." };
      queueMicrotask(() => this.emit("resolved", req, d));
      return Promise.resolve(d);
    }
    return new Promise<QuestionDecision>((resolve) => {
      const settle = (d: QuestionDecision) => {
        if (!this.open.has(req.id)) return;
        this.open.delete(req.id);
        signal?.removeEventListener("abort", onAbort);
        this.emit("resolved", req, d);
        resolve(d);
      };
      const onAbort = () => settle({ answered: false, reason: "The session was interrupted before an answer was given." });
      this.open.set(req.id, { req, settle });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.emit("pending", req);
    });
  }

  answer(id: string, answers: QuestionAnswers): boolean {
    const e = this.open.get(id);
    if (!e) return false;
    e.settle({ answered: true, answers });
    return true;
  }

  dismiss(id: string, reason?: string): boolean {
    const e = this.open.get(id);
    if (!e) return false;
    e.settle({ answered: false, reason });
    return true;
  }

  dismissAll(reason = "Session closed."): void {
    for (const { settle } of [...this.open.values()]) settle({ answered: false, reason });
  }
}
