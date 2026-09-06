import { useSyncExternalStore } from "react";
import { api } from "./api.js";
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

export interface UiState {
  connected: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  approvals: ApprovalView[];
  /** AskUserQuestion calls waiting for answers. */
  questions: QuestionView[];
  events: Record<string, AnyEvent[]>;
  verification: Record<string, VerificationState>;
  theme: ThemeName;
  scheme: SchemeName;
  termFontSize: number;
  toast: string | null;
}

const EVENT_CAP = 1500;
const LS = { theme: "mendophyte.theme", scheme: "mendophyte.scheme", active: "mendophyte.activeSession", termFont: "mendophyte.termFontSize" };

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
      verification: {},
      theme: (safeGet(LS.theme) as ThemeName) || "vine",
      scheme: (safeGet(LS.scheme) as SchemeName) || "auto",
      termFontSize: Number(safeGet(LS.termFont)) || 13,
      toast: null,
    };
  }

  setTermFontSize(px: number) {
    const v = Math.max(9, Math.min(28, Math.round(px)));
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
  }

  setTheme(theme: ThemeName) {
    safeSet(LS.theme, theme);
    this.set({ theme });
    this.applyTheme();
  }
  setScheme(scheme: SchemeName) {
    safeSet(LS.scheme, scheme);
    this.set({ scheme });
    this.applyTheme();
  }
  private applyTheme() {
    document.documentElement.dataset.theme = this.state.theme;
    document.documentElement.dataset.scheme = this.state.scheme;
  }

  toast(msg: string) {
    this.set({ toast: msg });
    setTimeout(() => this.state.toast === msg && this.set({ toast: null }), 4000);
  }

  // ---- sessions
  setActive(id: string | null) {
    safeSet(LS.active, id ?? "");
    this.set({ activeSessionId: id });
    if (id) this.ensureReplayed(id);
  }
  active(): SessionSummary | null {
    return this.state.sessions.find((s) => s.id === this.state.activeSessionId) ?? null;
  }

  async createSession(body: Parameters<typeof api.createSession>[0]) {
    const { session } = await api.createSession(body);
    this.upsertSession(session);
    this.setActive(session.id);
    return session;
  }

  async send(text: string) {
    const id = this.state.activeSessionId;
    if (!id) throw new Error("no active session");
    await api.send(id, text);
    this.appendEvent({ seq: -Date.now(), at: new Date().toISOString(), sessionId: id, event: "user_text", data: { text } });
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
      if (e.seq > 0 && cur.some((x) => x.seq === e.seq)) return {};
      const next = [...cur, e];
      if (next.length > EVENT_CAP) next.splice(0, next.length - EVENT_CAP);
      return { events: { ...st.events, [e.sessionId]: next } };
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
    this.wsSend({ type: "question.answer", id, answers });
    this.set((st) => ({ questions: st.questions.filter((q) => q.id !== id) }));
  }

  resolveApproval(id: string, approved: boolean, reason?: string) {
    this.wsSend({ type: "approval.resolve", id, approved, reason });
    // optimistic removal; the server's approval.resolved frame confirms it
    this.set((st) => ({ approvals: st.approvals.filter((a) => a.id !== id) }));
  }

  private connect() {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.replayed.clear();
      this.set({ connected: true });
    };
    ws.onclose = () => {
      this.set({ connected: false });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
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
          this.set((st) => (st.approvals.some((a) => a.id === m.approval.id) ? {} : { approvals: [...st.approvals, m.approval] }));
          return;
        case "approval.resolved":
          this.set((st) => ({ approvals: st.approvals.filter((a) => a.id !== m.approval.id) }));
          return;
        case "question.pending":
          this.set((st) => (st.questions.some((q) => q.id === m.question.id) ? {} : { questions: [...st.questions, m.question] }));
          return;
        case "question.resolved":
          this.set((st) => ({ questions: st.questions.filter((q) => q.id !== m.question.id) }));
          return;
        case "error":
          this.toast(m.message);
          return;
      }
    };
  }
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
export function useUi(): UiState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
export function useActiveSession(): SessionSummary | null {
  const s = useUi();
  return s.sessions.find((x) => x.id === s.activeSessionId) ?? null;
}
