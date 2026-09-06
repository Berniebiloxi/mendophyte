import { useEffect, useState } from "react";
import { store, useUi } from "./store.js";

/**
 * The guardrail confirmation. Shows the exact command and where it runs;
 * the agent is blocked until the user decides. Nothing else in the app is
 * interactive while one is pending, by design: this is not a toast.
 */
export function ApprovalsModal() {
  const { approvals, sessions } = useUi();
  const [reason, setReason] = useState("");
  const a = approvals[0];
  useEffect(() => setReason(""), [a?.id]);
  useEffect(() => {
    if (!a) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.resolveApproval(a.id, false, reason || undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a, reason]);
  if (!a) return null;
  const session = sessions.find((s) => s.id === a.sessionId);
  const critical = a.match.severity === "critical";
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="modal" style={critical ? undefined : { borderTopColor: "var(--m-warn)" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 id="approval-title">{a.match.description}</h2>
          <span className={`tag ${critical ? "bad" : "warn"}`}>{critical ? "irreversible" : "needs your go-ahead"}</span>
        </div>
        <div className="muted">
          The agent wants to run this in <code>{a.cwd}</code>
          {session ? <> for <b>{session.repoDir.split(/[\\/]/).pop()}</b></> : null}. Standing guardrail: <code>{a.match.ruleId}</code>.
          {approvals.length > 1 && <> {approvals.length - 1} more waiting.</>}
        </div>
        <div className="cmd">{a.command}</div>
        <label className="field">
          If declining, tell the agent why (optional)
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. not until the test is written" />
        </label>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn" onClick={() => store.resolveApproval(a.id, false, reason || undefined)} autoFocus>
            Decline
          </button>
          <button className={`btn ${critical ? "danger" : "primary"}`} onClick={() => store.resolveApproval(a.id, true)}>
            Run this exact command
          </button>
        </div>
      </div>
    </div>
  );
}
