import { useSyncExternalStore } from "react";
import { api } from "./api.js";
import { diag, diagError } from "./diag.js";
import type { AnyEvent, ApprovalView, DetectionReport, QuestionAnswers, QuestionView, SchemeName, SessionEvent, SessionSummary, ThemeName, VerificationProgress, VerificationRun } from "./types.js";

/**
 * One small store for the whole UI: sessions, the active one, per-session
 * event buffers, approvals, verification, theme. A websocket keeps it live
 * and replays the server's buffer on (re)connect so a refresh loses nothing.
 */

export interface VerificationState {
  detected: DetectionReport | null;
  runs: VerificationRun[];
  /** checkId -> running/finished while a run is in flight */
  running: Record<string, "running" | "done">;
  loaded: boolean;
}

/**
 * Per-session index kept up to date as events arrive, so panels can ask
 * "how many turns" or "the last artifacts event" through a selector that
 * returns a stable value, instead of scanning the whole event list on
 * every render.
 */
export interface EventMarks {
  counts: Record<string, number>;
  last: Record<string, AnyEvent>;
}

export interface UiState {
  connected: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  approvals: ApprovalView[];
  /** AskUserQuestion calls waiting for answers. */
  questions: QuestionView[];
  events: Record<string, AnyEvent[]>;
  marks: Record<string, EventMarks>;
  /** The assistant's reply in progress, per session, streamed token by token. */
  drafts: Record<string, string>;
  verification: Record<string, VerificationState>;
  theme: ThemeName;
  scheme: SchemeName;
  termFontSize: number;
  /** Global UI size: "auto" picks from the screen, otherwise a multiplier (1 = 100%). */
  uiScale: UiScale;
  /** Apply the workflow preset that matches the agent's phase as it changes. */
  layoutFollowsPhase: boolean;
  /** Set after File → Quit: the server is gone on purpose; stop reconnecting and say so. */
  stopped: boolean;
  toast: string | null;
}

export type UiScale = "auto" | number;
export const UI_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5] as const;

/**
 * A sensible size for the screen the window is on. Wide desktop monitors
 * at 1x get a larger UI; laptops stay at 100%. CSS pixels already account
 * for the OS scale factor, so a 4K monitor at 200% reads as 1920 here.
 */
export function autoUiScale(): number {
  const w = Math.max(window.screen?.width ?? 0, window.innerWidth);
  if (w >= 3800) return 1.3;
  if (w >= 3000) return 1.2;
  if (w >= 2400) return 1.1;
  return 1;
}
export function effectiveUiScale(s: UiScale): number {
  return s === "auto" ? autoUiScale() : s;
}

const EVENT_CAP = 1500;
const LS = { theme: "mendophyte.theme", scheme: "mendophyte.scheme", active: "mendophyte.activeSession", termFont: "mendophyte.termFontSize", uiScale: "mendophyte.uiScale", follow: "mendophyte.layoutFollowsPhase" };

class Store {
  state: UiState;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private retry = 0;
  private replayed = new Set<string>();

  constructor() {
    this.state = {
      connected: false,
      sessions: [],
      activeSessionId: safeGet(LS.active),
      approvals: [],
      questions: [],
      events: {},
      marks: {},
      drafts: {},
      verification: {},
      theme: (safeGet(LS.theme) as ThemeName) || "vine",
      scheme: (safeGet(LS.scheme) as SchemeName) || "auto",
      termFontSize: Number(safeGet(LS.termFont)) || 13,
      uiScale: readScale(safeGet(LS.uiScale)),
      layoutFollowsPhase: safeGet(LS.follow) === "1",
      stopped: false,
      toast: null,
    };
  }

  async quit() {
    diag("quit requested from File menu");
    try {
      await api.shutdown();
    } catch {
      /* the socket closing is the confirmation */
    }
    this.set({ stopped: true, connected: false });
  }

  setLayoutFollowsPhase(on: boolean) {
    diag(`layout follows phase: ${on}`);
    safeSet(LS.follow, on ? "1" : "0");
    this.set({ layoutFollowsPhase: on });
  }

  setUiScale(scale: UiScale) {
    diag(`ui scale ${scale === "auto" ? `auto (${Math.round(autoUiScale() * 100)}%)` : `${Math.round(scale * 100)}%`}`);
    safeSet(LS.uiScale, String(scale));
    this.set({ uiScale: scale });
    this.applyTheme();
  }

  setTermFontSize(px: number) {
    const v = Math.max(9, Math.min(28, Math.round(px)));
    diag(`terminal font ${v}px`);
    safeSet(LS.termFont, String(v));
    this.set({ termFontSize: v });
  }

  // ---- react binding
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = () => this.state;
  private set(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  // ---- lifecycle
  boot() {
    this.applyTheme();
    this.connect();
    // Moving the window to another monitor changes the screen; "auto" follows it.
    let lastW = window.screen?.width ?? 0;
    window.addEventListener("resize", () => {
      const w = window.screen?.width ?? 0;
      if (w !== lastW) {
        lastW = w;
        if (this.state.uiScale === "auto") this.applyTheme();
      }
    });
  }

  setTheme(theme: ThemeName) {
    diag(`theme ${theme}`);
    safeSet(LS.theme, theme);
    this.set({ theme });
    this.applyTheme();
  }
  setScheme(scheme: SchemeName) {
    diag(`scheme ${scheme}`);
    safeSet(LS.scheme, scheme);
    this.set({ scheme });
    this.applyTheme();
  }
  private applyTheme() {
    document.documentElement.dataset.theme = this.state.theme;
    document.documentElement.dataset.scheme = this.state.scheme;
    document.documentElement.style.setProperty("--m-ui-scale", String(effectiveUiScale(this.state.uiScale)));
  }

  toast(msg: string) {
    diag(`toast "${msg}"`);
    this.set({ toast: msg });
    setTimeout(() => this.state.toast === msg && this.set({ toast: null }), 4000);
  }

  // ---- sessions
  setActive(id: string | null) {
    if (id !== this.state.activeSessionId) diag(`active session → ${id ?? "none"}`);
    safeSet(LS.active, id ?? "");
    this.set({ activeSessionId: id });
    if (id) this.ensureReplayed(id);
  }
  active(): SessionSummary | null {
    return this.state.sessions.find((s) => s.id === this.state.activeSessionId) ?? null;
  }

  async createSession(body: Parameters<typeof api.createSession>[0]) {
    diag(`createSession repo=${body.repoDir} model=${body.model ?? "default"} preflight=${body.preflight ?? true}`);
    const { session } = await api.createSession(body);
    this.upsertSession(session);
    this.setActive(session.id);
    return session;
  }

  async send(text: string) {
    const id = this.state.activeSessionId;
    if (!id) throw new Error("no active session");
    diag(`send to ${id}: "${text.slice(0, 200).replace(/\s+/g, " ")}"${text.length > 200 ? ` (+${text.length - 200} chars)` : ""}`);
    await api.send(id, text);
    // the server records the message as a user_text event and streams it back, so replays keep it
  }

  private upsertSession(s: SessionSummary) {
    this.set((st) => {
      const i = st.sessions.findIndex((x) => x.id === s.id);
      const sessions = [...st.sessions];
      if (i >= 0) sessions[i] = s;
      else sessions.push(s);
      return { sessions };
    });
  }

  private appendEvent(e: AnyEvent) {
    this.set((st) => {
      const cur = st.events[e.sessionId] ?? [];
      // Duplicates only ever arrive at the tail (a replay overlapping the live stream).
      if (e.seq > 0) for (let i = cur.length - 1; i >= 0 && i >= cur.length - 50; i--) if (cur[i].seq === e.seq) return {};
      const next = [...cur, e];
      if (next.length > EVENT_CAP) next.splice(0, next.length - EVENT_CAP);
      const m = st.marks[e.sessionId] ?? { counts: {}, last: {} };
      const marks: EventMarks = { counts: { ...m.counts, [e.event]: (m.counts[e.event] ?? 0) + 1 }, last: { ...m.last, [e.event]: e } };
      return { events: { ...st.events, [e.sessionId]: next }, marks: { ...st.marks, [e.sessionId]: marks } };
    });
    if (e.event === "verification" || e.event === "verification_detected" || e.event === "verification_progress") this.applyVerificationEvent(e as SessionEvent);
  }

  private lastSeq(id: string): number {
    const evs = this.state.events[id] ?? [];
    let m = 0;
    for (const e of evs) if (e.seq > m) m = e.seq;
    return m;
  }

  private ensureReplayed(id: string) {
    if (this.replayed.has(id)) return;
    this.replayed.add(id);
    this.wsSend({ type: "replay", sessionId: id, afterSeq: this.lastSeq(id) });
  }

  // ---- verification
  async loadVerification(id: string) {
    const v = await api.verification(id);
    this.set((st) => ({ verification: { ...st.verification, [id]: { detected: v.detected, runs: v.runs, running: {}, loaded: true } } }));
  }
  private applyVerificationEvent(e: SessionEvent) {
    this.set((st) => {
      const cur: VerificationState = st.verification[e.sessionId] ?? { detected: null, runs: [], running: {}, loaded: false };
      let next = cur;
      if (e.event === "verification_detected") next = { ...cur, detected: e.data as DetectionReport };
      if (e.event === "verification_progress") {
        const p = e.data as VerificationProgress;
        const running = { ...cur.running };
        if (p.phase === "start") running[p.check.id] = "running";
        else running[p.result.id] = "done";
        next = { ...cur, running };
      }
      if (e.event === "verification") {
        const run = e.data as VerificationRun;
        next = { ...cur, runs: [run, ...cur.runs.filter((r) => r.id !== run.id)].slice(0, 20), running: {} };
      }
      return { verification: { ...st.verification, [e.sessionId]: next } };
    });
  }

  // ---- websocket
  private wsSend(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  answerQuestion(id: string, answers: QuestionAnswers) {
    diag(`answerQuestion ${id} ${JSON.stringify(answers).slice(0, 300)}`);
    this.wsSend({ type: "question.answer", id, answers });
    this.set((st) => ({ questions: st.questions.filter((q) => q.id !== id) }));
  }

  resolveApproval(id: string, approved: boolean, reason?: string) {
    diag(`resolveApproval ${id} ${approved ? "APPROVED" : "denied"}${reason ? ` reason="${reason.slice(0, 200)}"` : ""}`);
    this.wsSend({ type: "approval.resolve", id, approved, reason });
    // optimistic removal; the server's approval.resolved frame confirms it
    this.set((st) => ({ approvals: st.approvals.filter((a) => a.id !== id) }));
  }

  private connect() {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      diag(`ws open (retry ${this.retry})`);
      this.retry = 0;
      this.replayed.clear();
      this.set({ connected: true });
    };
    ws.onclose = (ev) => {
      this.set({ connected: false });
      if (this.state.stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      diag(`ws closed code=${ev.code} reason="${ev.reason}" → reconnect in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (m.type) {
        case "snapshot": {
          const sessions: SessionSummary[] = m.sessions ?? [];
          diag(`snapshot: ${sessions.length} session(s), ${(m.approvals ?? []).length} approval(s), ${(m.questions ?? []).length} question(s)`);
          let active = this.state.activeSessionId;
          if (!active || !sessions.some((s) => s.id === active)) active = sessions.find((s) => s.status === "running")?.id ?? sessions[0]?.id ?? null;
          this.set({ sessions, approvals: m.approvals ?? [], questions: m.questions ?? [], activeSessionId: active });
          if (active) this.ensureReplayed(active);
          return;
        }
        case "session.created":
        case "session.updated":
          this.upsertSession(m.session);
          if (!this.state.activeSessionId) this.setActive(m.session.id);
          return;
        case "session.removed":
          this.set((st) => ({
            sessions: st.sessions.filter((s) => s.id !== m.id),
            activeSessionId: st.activeSessionId === m.id ? null : st.activeSessionId,
          }));
          return;
        case "session.event": {
          const { type: _t, ...e } = m;
          this.appendEvent(e as SessionEvent);
          return;
        }
        case "approval.pending":
          diag(`approval.pending ${m.approval.id} [${m.approval.match?.ruleId}] shown`);
          this.set((st) => (st.approvals.some((a) => a.id === m.approval.id) ? {} : { approvals: [...st.approvals, m.approval] }));
          return;
        case "approval.resolved":
          this.set((st) => ({ approvals: st.approvals.filter((a) => a.id !== m.approval.id) }));
          return;
        case "question.pending":
          diag(`question.pending ${m.question.id} shown (${(m.question.questions ?? []).length} question(s))`);
          this.set((st) => (st.questions.some((q) => q.id === m.question.id) ? {} : { questions: [...st.questions, m.question] }));
          return;
        case "question.resolved":
          this.set((st) => ({ questions: st.questions.filter((q) => q.id !== m.question.id) }));
          return;
        case "session.draft":
          this.set((st) => {
            const text = String(m.text ?? "");
            if ((st.drafts[m.sessionId] ?? "") === text) return {};
            return { drafts: { ...st.drafts, [m.sessionId]: text } };
          });
          return;
        case "error":
          diagError(`ws error frame: ${m.message}${m.inReplyTo ? ` (in reply to ${m.inReplyTo})` : ""}`);
          this.toast(m.message);
          return;
      }
    };
  }
}

function readScale(raw: string | null): UiScale {
  if (!raw || raw === "auto") return "auto";
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : "auto";
}
function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

export const store = new Store();

const EMPTY_EVENTS: AnyEvent[] = [];
const EMPTY_MARKS: EventMarks = { counts: {}, last: {} };

/**
 * Subscribe to the store. With a selector, the component re-renders only
 * when the selected value changes (by identity), so pass selectors that
 * return primitives or slices the store replaces only when they change.
 * Without one, every store update re-renders the caller; keep that for
 * components that really do need the whole state.
 */
export function useUi(): UiState;
export function useUi<T>(selector: (s: UiState) => T): T;
export function useUi<T>(selector?: (s: UiState) => T): T | UiState {
  const get = (selector ? () => selector(store.state) : store.get) as () => T | UiState;
  return useSyncExternalStore(store.subscribe, get, get);
}
export function useActiveSession(): SessionSummary | null {
  return useUi((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
}
/** The active session's events; a stable empty array when there is none. */
export function useSessionEvents(id: string | null | undefined): AnyEvent[] {
  return useUi((s) => (id ? s.events[id] : undefined) ?? EMPTY_EVENTS);
}
/** The most recent event of one kind for a session, without scanning the list. */
export function useLastEvent(id: string | null | undefined, event: string): AnyEvent | undefined {
  return useUi((s) => (id ? s.marks[id] ?? EMPTY_MARKS : EMPTY_MARKS).last[event]);
}
/** How many events of the given kinds a session has had; a number, so cheap to compare. */
export function useEventCount(id: string | null | undefined, ...events: string[]): number {
  return useUi((s) => {
    const m = id ? s.marks[id] : undefined;
    if (!m) return 0;
    let n = 0;
    for (const e of events) n += m.counts[e] ?? 0;
    return n;
  });
}
