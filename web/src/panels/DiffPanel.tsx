import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useActiveSession, useUi } from "../store.js";
import type { DiffReport } from "../types.js";

function cls(line: string): string {
  if (line.startsWith("diff --git")) return "l file";
  if (line.startsWith("@@")) return "l hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "l";
  if (line.startsWith("+")) return "l add";
  if (line.startsWith("-")) return "l del";
  return "l";
}

/**
 * Real `git diff`, refreshed after every turn. Locked while the agent's
 * structured state says a your-turn item blocks the diff: "Do not show me
 * a diff until I've stated what I think the fix is" is enforced here, in
 * the UI, not left to the agent's discretion.
 */
export function DiffPanel() {
  const s = useActiveSession();
  const { events } = useUi();
  const [diff, setDiff] = useState<DiffReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const turns = s ? (events[s.id] ?? []).filter((e) => e.event === "turn" || e.event === "verification").length : 0;

  const load = () => {
    if (!s) return;
    api.diff(s.id).then((r) => { setDiff(r.diff); setErr(null); }).catch((e) => setErr(e.message));
  };
  useEffect(load, [s?.id, turns]);

  const lock = s?.lastState?.your_turn_items.find((i) => i.blocks === "diff");

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;
  return (
    <div className="diff-wrap">
      <div className="row" style={{ padding: "6px 10px", borderBottom: "1px solid var(--m-border)", background: "var(--m-bg-2)" }}>
        <button className="btn sm" onClick={load}>Refresh</button>
        {diff && (
          <span className="faint">
            {diff.branch} @ {diff.head} · {diff.filesChanged} files, +{diff.insertions} −{diff.deletions}{diff.status.filter((x) => x.code === "??").length ? ` · ${diff.status.filter((x) => x.code === "??").length} untracked` : ""}
          </span>
        )}
        {err && <span className="tag bad">{err}</span>}
      </div>
      <div className="diff" style={{ height: "calc(100% - 34px)" }}>
        {diff && !diff.patch && <div className="empty" style={{ padding: 12, whiteSpace: "normal" }}>Working tree matches HEAD.</div>}
        {diff?.patch.split("\n").map((l, i) => (
          <div key={i} className={cls(l)}>{l || " "}</div>
        ))}
      </div>
      {lock && (
        <div className="lock">
          <div className="big">The diff stays hidden until it’s your move.</div>
          <div className="muted">{lock.prompt}</div>
          <div className="faint">Answer it in the “Your turn” panel. This is the meta-prompt’s handoff, not a permission setting.</div>
        </div>
      )}
    </div>
  );
}
