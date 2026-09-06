import { memo, useState } from "react";
import { useActiveSession, useSessionEvents } from "../store.js";
import type { AnyEvent } from "../types.js";

function summary(e: AnyEvent): string {
  const d: any = e.data;
  switch (e.event) {
    case "message": {
      const t = d?.type;
      if (t === "assistant") return "assistant: " + (d.message?.content ?? []).map((b: any) => (b.type === "text" ? b.text.slice(0, 80) : `[${b.type} ${b.name ?? ""}]`)).join(" | ");
      if (t === "user") return "user: " + JSON.stringify(d.message?.content).slice(0, 100);
      return `${t}${d?.subtype ? "/" + d.subtype : ""}`;
    }
    case "tool_use":
      return `${d.name} ${JSON.stringify(d.input).slice(0, 100)}`;
    case "assistant_text":
    case "user_text":
      return String(d.text).slice(0, 120);
    case "turn":
      return `${d.subtype} · ${d.num_turns} agentic turns${d.total_cost_usd != null ? ` · $${Number(d.total_cost_usd).toFixed(3)}` : ""}`;
    case "state":
      return `phase ${d.phase}${d.phase_complete ? " complete" : ""} · ${d.your_turn_items.length} your-turn`;
    case "init":
      return `${d.model} · ${d.permissionMode} · ${d.sessionId}`;
    default:
      return JSON.stringify(d ?? null).slice(0, 120);
  }
}

export function TranscriptPanel() {
  const s = useActiveSession();
  const all = useSessionEvents(s?.id);
  const [raw, setRaw] = useState(false);
  const list = raw ? all : all.filter((e) => e.event !== "message");
  return (
    <div className="panel tr">
      <div className="row" style={{ marginBottom: 6 }}>
        <label className="row"><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> include raw SDK messages</label>
        <span className="faint">{list.length} events</span>
      </div>
      {list.map((e) => (
        <div key={e.seq} className="e">
          <span className="t">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
          <span className="n">{e.event}</span>
          <span>{summary(e)}</span>
        </div>
      ))}
    </div>
  );
}
