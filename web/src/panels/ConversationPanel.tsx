import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { store, useActiveSession, useSessionEvents, useUi } from "../store.js";
import type { AnyEvent } from "../types.js";
import { looksLikeMarkdown, renderMarkdown, splitSections } from "../markdown.js";

function toolLine(data: any): string {
  const name = String(data?.name ?? "");
  if (name === "Bash") return `$ ${String(data?.input?.command ?? "")}`;
  if (name === "Read") return `read ${String(data?.input?.file_path ?? "")}`;
  if (name === "Edit" || name === "Write") return `${name.toLowerCase()} ${String(data?.input?.file_path ?? "")}`;
  if (name === "Grep") return `grep ${String(data?.input?.pattern ?? "")}`;
  if (name === "Glob") return `glob ${String(data?.input?.pattern ?? "")}`;
  if (name.startsWith("mcp__mendophyte__")) return `mendophyte · ${name.replace("mcp__mendophyte__", "")} ${JSON.stringify(data?.input ?? {})}`;
  if (name === "StructuredOutput") return "dashboard state";
  return `${name} ${JSON.stringify(data?.input ?? {}).slice(0, 120)}`;
}

/**
 * An assistant reply. Agents write Markdown, and its structure is reliable
 * enough to lean on: each heading starts a titled box, tables become
 * tables, fences become code. Plain replies stay plain.
 */
const Assistant = memo(function Assistant({ text }: { text: string }) {
  const sections = useMemo(() => {
    if (!looksLikeMarkdown(text)) return null;
    return splitSections(text).map((s) => ({ ...s, html: renderMarkdown(s.body) }));
  }, [text]);
  if (!sections) return <div className="msg assistant">{text}</div>;
  const titled = sections.some((s) => s.title !== null);
  return (
    <div className={`msg assistant rich${titled ? " sectioned" : ""}`}>
      {sections.map((s, i) =>
        s.title === null ? (
          <div key={i} className="prose" dangerouslySetInnerHTML={{ __html: s.html }} />
        ) : (
          <section key={i} className={`sec lv${s.level}`}>
            <h4 className="sec-title">{s.title}</h4>
            {s.body.trim() && <div className="prose" dangerouslySetInnerHTML={{ __html: s.html }} />}
          </section>
        )
      )}
    </div>
  );
});

const Entry = memo(function Entry({ e }: { e: AnyEvent }) {
  switch (e.event) {
    case "assistant_text":
      return <Assistant text={(e.data as any).text} />;
    case "user_text": {
      const d = e.data as { text: string; kickoff?: boolean };
      if (d.kickoff)
        return (
          <details className="msg kickoff">
            <summary>Kickoff sent to the agent: the entry prompt plus the pre-flight facts</summary>
            <div className="kickoff-body">{d.text}</div>
          </details>
        );
      return <div className="msg user">{d.text}</div>;
    }
    case "tool_use":
      return <div className="msg tool">▸ {toolLine(e.data)}</div>;
    case "turn": {
      const d = e.data as any;
      const t = d.timing as { wallMs: number; apiMs: number | null; firstTextMs: number | null; waitingOnUserMs?: number } | null | undefined;
      const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
      return (
        <div className="msg turn" title={t ? `From your message to the result: ${secs(t.wallMs)} wall clock, of which the model API took ${t.apiMs != null ? secs(t.apiMs) : "?"}. First streamed text after ${t.firstTextMs != null ? secs(t.firstTextMs) : "?"}. The gap between wall and API time is tool execution and process overhead.` : undefined}>
          {d.interrupted ? "stopped by you" : `turn ${d.subtype}`}
          {t ? ` · ${secs(t.wallMs)}${t.waitingOnUserMs ? ` (${secs(t.waitingOnUserMs)} waiting on you)` : ""}${t.apiMs != null ? ` (api ${secs(t.apiMs)})` : ""}` : ""}
          {d.total_cost_usd != null ? ` · $${Number(d.total_cost_usd).toFixed(3)} so far` : ""}
          {d.stateError && !d.interrupted ? ` · no state: ${d.stateError}` : ""}
        </div>
      );
    }
    case "error":
      return <div className="msg error">{(e.data as any).message}</div>;
    case "end":
      return <div className="msg turn">session ended</div>;
    case "verification": {
      const r = e.data as any;
      return <div className="msg turn">verification: {r.allPassed ? "all passed" : `${r.counts.failed} failed`} ({r.results.length} checks)</div>;
    }
    default:
      return null;
  }
});

/** Themed loader: three leaves unfurling in turn (pure CSS, see .thinking). */
function Thinking({ label }: { label: string }) {
  return (
    <div className="msg thinking" role="status" aria-live="polite">
      <span className="leaves"><i /><i /><i /></span>
      <span className="muted">{label}</span>
    </div>
  );
}

export function ConversationPanel() {
  const s = useActiveSession();
  const list = useSessionEvents(s?.id);
  const draft = useUi((st) => (s ? st.drafts[s.id] : undefined) ?? "");
  const working = !!s?.busy && s.status === "running";
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list.length, draft.length, working]);

  const send = async () => {
    const t = text.trim();
    if (!t || !s) return;
    setBusy(true);
    try {
      await store.send(t);
      setText("");
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conv">
      <div
        className="conv-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!s && <div className="empty">Start a session from the Session panel (File → New session).</div>}
        {s && list.length === 0 && <div className="empty">Waiting for the agent…</div>}
        {list.map((e) => (
          <Entry key={`${e.seq}`} e={e} />
        ))}
        {draft && <div className="msg assistant draft">{draft}<span className="caret" /></div>}
        {working && !draft && <Thinking label={list.length ? "working…" : "reading the prompt and your repo…"} />}
      </div>
      <div className="conv-input">
        <textarea
          value={text}
          disabled={!s || s.status !== "running"}
          onChange={(e) => setText(e.target.value)}
          placeholder={s ? "Message the agent (Enter to send, Shift+Enter for a new line)" : "No session"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="stack">
          <button className="btn primary" disabled={!s || busy || !text.trim()} onClick={send}>
            Send
          </button>
          <button className="btn sm" disabled={!s} title="Interrupt the current turn" onClick={() => s && api.interrupt(s.id).catch((e) => store.toast(e.message))}>
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
