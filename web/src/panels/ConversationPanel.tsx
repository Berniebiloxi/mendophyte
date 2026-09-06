import { memo, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { store, useActiveSession, useSessionEvents } from "../store.js";
import type { AnyEvent } from "../types.js";

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

const Entry = memo(function Entry({ e }: { e: AnyEvent }) {
  switch (e.event) {
    case "assistant_text":
      return <div className="msg assistant">{(e.data as any).text}</div>;
    case "user_text":
      return <div className="msg user">{(e.data as any).text}</div>;
    case "tool_use":
      return <div className="msg tool">▸ {toolLine(e.data)}</div>;
    case "turn": {
      const d = e.data as any;
      return (
        <div className="msg turn">
          turn {d.subtype}{d.total_cost_usd != null ? ` · $${Number(d.total_cost_usd).toFixed(3)} so far` : ""}{d.stateError ? ` · no state: ${d.stateError}` : ""}
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

export function ConversationPanel() {
  const s = useActiveSession();
  const list = useSessionEvents(s?.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list.length]);

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
