import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { ApprovalBroker, QuestionBroker, type AskQuestion } from "./approvals.js";
import { buildAppendSystemPrompt, loadPersistentSections } from "./entry-sections.js";
import {
  DEFAULT_GUARDRAIL_RULES,
  commandFromToolInput,
  matchGuardrail,
  type GuardrailRule,
} from "./guardrails.js";
import { SESSION_STATE_JSON_SCHEMA, parseSessionState, type SessionState } from "./schema.js";
import { MENDOPHYTE_MCP_NAME, MENDOPHYTE_TOOL_ALLOWLIST, createMendophyteMcpServer } from "./tools.js";
import type { FragilityReport } from "./fragility/index.js";
import type { DetectionReport, VerificationProgress, VerificationRun } from "./verification/index.js";
import type { SubmissionReport } from "./submission.js";
import type { FeedbackLog } from "./feedback-log.js";
import type { BenchRun } from "./benchmark.js";

export interface SessionConfig {
  /** Absolute path to the target repository clone. Becomes the agent's cwd. */
  repoDir: string;
  /** Absolute path to this repository's artifact home (outside the clone). */
  artifactHome: string;
  /** Absolute path to the directory holding the six meta-prompt files. */
  promptDir: string;
  approvals: ApprovalBroker;
  /** Where the agent's AskUserQuestion calls go. Optional; without one they are declined with a hint to ask in prose. */
  questions?: QuestionBroker;
  guardrails?: GuardrailRule[];
  /** Model alias or id. Omit to use the user's own Claude Code default. */
  model?: string;
  maxTurns?: number;
  /** Extra env for the Claude Code subprocess, merged over process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * The SDK refuses to launch when it inherits a parent Claude Code session's
   * env (`CLAUDECODE`). Mendophyte spawns its own dedicated process, so this
   * is stripped by default; set false to keep the inherited value.
   */
  stripNestedSessionEnv?: boolean;
  /** Set false to run without `outputFormat` (debugging only; the dashboard needs it). */
  structuredOutput?: boolean;
  /**
   * Permission mode for the underlying session. `default` is what the
   * design assumes. Other modes are accepted so the guardrail hard floor
   * can be exercised under them (see the live test), not as a product option.
   */
  permissionMode?: Options["permissionMode"];
  pathToClaudeCodeExecutable?: string;
  /** Set false to keep the transcript out of ~/.claude/projects (tests). Default true, so sessions can be resumed later. */
  persistSession?: boolean;
  /** Set false to run without Mendophyte's in-process tools (fragility map etc.). */
  tools?: boolean;
  onStderr?: (chunk: string) => void;
}

export interface TurnEvent {
  result: SDKResultMessage;
  /** Parsed dashboard state, when the turn produced a valid structured output. */
  state: SessionState | null;
  /** Why `state` is null when the result was otherwise successful. */
  stateError?: string;
}

export interface SessionEvents {
  /** Every raw SDK message, for logging/transcript panels. */
  message: (m: SDKMessage) => void;
  init: (info: { sessionId: string; model: string; permissionMode: string; tools: string[] }) => void;
  assistant_text: (text: string) => void;
  tool_use: (info: { name: string; input: unknown; id: string }) => void;
  /** A tool call that canUseTool allowed without a human (not on the guardrail list). */
  tool_allowed: (info: { toolName: string; input: Record<string, unknown> }) => void;
  turn: (t: TurnEvent) => void;
  state: (s: SessionState) => void;
  /** The agent called the fragility_map tool; here is what it got. */
  fragility: (r: FragilityReport) => void;
  verification_detected: (d: DetectionReport) => void;
  verification_progress: (p: VerificationProgress) => void;
  /** A run_verification call finished; real exit codes, the only source of a checkmark. */
  verification: (run: VerificationRun) => void;
  /** The agent asked for submission status; the same report the panel polls. */
  submission: (report: SubmissionReport) => void;
  /** The agent read or changed Artifact F through its tool. */
  feedback_log: (log: FeedbackLog) => void;
  /** The agent ran a benchmark through its tool. */
  benchmark: (run: BenchRun) => void;
  error: (e: Error) => void;
  end: () => void;
}

/**
 * One long-lived, streaming-input Agent SDK session wrapped for the
 * orchestrator: a push-based input queue, the guardrail permission layer
 * (canUseTool + PreToolUse hard floor), and per-turn structured state.
 *
 * Resume is deliberately NOT a feature of this class. Per the handoff,
 * Phase 0 step 0's resume check is a fresh session that is handed the
 * precomputed facts, so a resume is just `new MendophyteSession(...)` with
 * a different kickoff message.
 */
export class MendophyteSession extends EventEmitter {
  readonly config: SessionConfig;
  private q: Query | null = null;
  private inbox: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private inputClosed = false;
  private started = false;
  private _sessionId: string | null = null;
  private _lastState: SessionState | null = null;

  constructor(config: SessionConfig) {
    super();
    this.config = config;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get lastState(): SessionState | null {
    return this._lastState;
  }

  /**
   * Builds options, spawns the session and starts consuming the SDK stream
   * in the background. Resolves as soon as the subprocess is launched.
   *
   * It deliberately does NOT wait for `system/init`: in streaming-input
   * mode the CLI emits init only after the first user message arrives, so
   * awaiting it before `send()` would deadlock. Listen for the `init`
   * event (or read `sessionId` after the first turn) instead.
   */
  async start(): Promise<void> {
    if (this.started) throw new Error("Session already started");
    this.started = true;

    const options = await this.buildOptions();
    this.q = query({ prompt: this.inputStream(), options });
    void this.pump();
  }

  /** Queues a user message for the live session. */
  send(text: string): void {
    if (this.inputClosed) throw new Error("Session input is closed");
    this.inbox.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  /** Interrupts whatever the agent is doing in the current turn. */
  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  /**
   * Ends the input stream so the CLI finishes the current turn and exits
   * cleanly. `end` fires when the stream drains.
   */
  end(): void {
    this.inputClosed = true;
    this.wake?.();
  }

  /** Forceful shutdown: kills the subprocess and denies any pending approvals. */
  close(): void {
    this.inputClosed = true;
    this.wake?.();
    this.config.approvals.denyAll("Session closed.");
    this.config.questions?.dismissAll("Session closed.");
    this.q?.close();
  }

  // ---- internals -------------------------------------------------------

  private async buildOptions(): Promise<Options> {
    const c = this.config;
    const sections = await loadPersistentSections(c.promptDir);
    const append = buildAppendSystemPrompt(sections, {
      promptDir: c.promptDir,
      artifactHome: c.artifactHome,
      repoDir: c.repoDir,
    });

    const rules = c.guardrails ?? DEFAULT_GUARDRAIL_RULES;

    const env: NodeJS.ProcessEnv = { ...process.env, ...(c.env ?? {}) };
    if (c.stripNestedSessionEnv !== false) {
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_CHILD_SESSION;
    }
    env.CLAUDE_AGENT_SDK_CLIENT_APP ??= "mendophyte/0.1.0";

    // Hard floor. Runs before deny/ask rules, permission mode and allow
    // rules, so a guardrail command is forced to prompt even if the session
    // is ever in bypassPermissions or the tool is covered by an allow rule.
    // It returns `ask` (not `deny`) so the decision still flows through the
    // canUseTool promise and the human-in-the-loop modal.
    const guardrailFloor: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
      const match = matchGuardrail(commandFromToolInput(input.tool_input), rules);
      if (!match) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Mendophyte guardrail (${match.ruleId}): ${match.description}. Requires the user's explicit confirmation.`,
        },
      };
    };

    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      if (toolName === "AskUserQuestion") {
        // Claude Code's clarifying-question tool always lands here; the user answers in the UI.
        const questions = Array.isArray((input as any).questions) ? ((input as any).questions as AskQuestion[]) : [];
        const broker = c.questions ?? new QuestionBroker();
        const d = await broker.request(questions, signal);
        if (d.answered) return { behavior: "allow", updatedInput: { questions, answers: d.answers } };
        return { behavior: "deny", message: d.reason ?? "The user did not answer; ask in prose instead." };
      }
      const command = toolName === "Bash" ? commandFromToolInput(input) : "";
      const match = toolName === "Bash" ? matchGuardrail(command, rules) : null;

      if (!match) {
        // Not on the guardrail list. Anything that reached here fell through
        // every earlier step (so it's not Read/Grep/Glob) but is ordinary
        // work: running tests, git status, editing files in the clone.
        this.emit("tool_allowed", { toolName, input });
        return { behavior: "allow", updatedInput: input };
      }

      const decision = await c.approvals.request(
        { toolName, input, command, match, cwd: c.repoDir },
        signal
      );
      if (decision.approved) {
        return { behavior: "allow", updatedInput: input };
      }
      const why = decision.reason ? ` Reason given: ${decision.reason}` : "";
      return {
        behavior: "deny",
        message: `The user declined to run this command (${match.description}).${why} Do not retry it unchanged; state what you wanted to do and wait for the user.`,
      };
    };

    const useTools = c.tools !== false;
    const mcpServers = useTools
      ? {
          [MENDOPHYTE_MCP_NAME]: createMendophyteMcpServer({
            repoDir: c.repoDir,
            artifactHome: c.artifactHome,
            guardrails: rules,
            onFragility: (r) => this.emit("fragility", r),
            onVerificationDetected: (d) => this.emit("verification_detected", d),
            onVerificationProgress: (p) => this.emit("verification_progress", p),
            onVerification: (run) => this.emit("verification", run),
            onSubmission: (r) => this.emit("submission", r),
            onFeedbackLog: (l) => this.emit("feedback_log", l),
            onBenchmark: (b) => this.emit("benchmark", b),
          }),
        }
      : undefined;

    return {
      cwd: c.repoDir,
      additionalDirectories: [c.artifactHome, c.promptDir],
      systemPrompt: { type: "preset", preset: "claude_code", append },
      allowedTools: ["Read", "Grep", "Glob", ...(useTools ? MENDOPHYTE_TOOL_ALLOWLIST : [])],
      mcpServers,
      permissionMode: c.permissionMode ?? "default",
      allowDangerouslySkipPermissions: c.permissionMode === "bypassPermissions" ? true : undefined,
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [guardrailFloor] }] },
      outputFormat:
        c.structuredOutput === false
          ? undefined
          : { type: "json_schema", schema: SESSION_STATE_JSON_SCHEMA },
      model: c.model,
      maxTurns: c.maxTurns,
      env,
      pathToClaudeCodeExecutable: c.pathToClaudeCodeExecutable,
      persistSession: c.persistSession,
      stderr: c.onStderr,
    };
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (this.inbox.length) {
        yield this.inbox.shift()!;
        continue;
      }
      if (this.inputClosed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }

  private async pump(): Promise<void> {
    try {
      for await (const m of this.q!) {
        this.dispatch(m);
      }
      this.emit("end");
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
      this.emit("end");
    }
  }

  private dispatch(m: SDKMessage): void {
    this.emit("message", m);

    if (m.type === "system" && m.subtype === "init") {
      this._sessionId = m.session_id;
      this.emit("init", {
        sessionId: m.session_id,
        model: m.model,
        permissionMode: m.permissionMode,
        tools: m.tools,
      });
      return;
    }

    if (m.type === "assistant") {
      const texts: string[] = [];
      for (const block of m.message.content) {
        if (block.type === "text") texts.push(block.text);
        else if (block.type === "tool_use") {
          this.emit("tool_use", { name: block.name, input: block.input, id: block.id });
        }
      }
      if (texts.length) this.emit("assistant_text", texts.join("\n"));
      return;
    }

    if (m.type === "result") {
      let state: SessionState | null = null;
      let stateError: string | undefined;
      if (m.subtype === "success") {
        if (m.structured_output === undefined) {
          stateError = this.config.structuredOutput === false
            ? "structured output disabled"
            : "result was success but carried no structured_output";
        } else {
          const parsed = parseSessionState(m.structured_output);
          if (parsed.state) state = parsed.state;
          else stateError = parsed.error;
        }
      } else {
        stateError = `result subtype ${m.subtype}`;
      }
      if (state) {
        this._lastState = state;
        this.emit("state", state);
      }
      this.emit("turn", { result: m, state, stateError });
    }
  }

  // Typed emitter overloads
  override on<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
  override once<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): this;
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }
  override off<E extends keyof SessionEvents>(event: E, listener: SessionEvents[E]): this;
  override off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}

/** Default location of the six meta-prompt files: the package's prompts/ directory. */
export function defaultPromptDir(): string {
  // src/orchestrator/session.ts -> dist/orchestrator/session.js at runtime; two levels up is the package root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "prompts");
}

/**
 * The message that starts a fresh session on the meta-prompt. Kept here so
 * the CLI harness, tests and the future server all kick off identically.
 * `facts` is where the orchestrator's precomputed deterministic checks
 * (Phase 0 steps 3-5, resume diff) get handed over once those exist.
 */
export function buildKickoffMessage(opts: { repoUrl?: string; facts?: string }): string {
  const lines = [
    "Begin. Read 00-entry.md from the meta-prompt directory named in your",
    "system prompt and follow it from Phase 0, step 0.",
  ];
  if (opts.repoUrl) lines.push("", `The target repository is: ${opts.repoUrl}`);
  if (opts.facts) lines.push("", "Facts already established by Mendophyte (treat as observed):", "", opts.facts);
  return lines.join("\n");
}
