import { useEffect, useState } from "react";
import { api } from "../api.js";
import { store, useActiveSession, useUi } from "../store.js";
import type { CheckResult } from "../types.js";

function Result({ r }: { r: CheckResult }) {
  return (
    <details>
      <summary className="check">
        <span className={`st ${r.status}`}>{r.status.toUpperCase()}</span>
        <code>{r.command}</code>
        <span className="faint">{r.exitCode !== null ? `exit ${r.exitCode} · ` : ""}{(r.durationMs / 1000).toFixed(1)}s</span>
      </summary>
      {r.reason && <div className="muted" style={{ margin: "4px 0 0 76px" }}>{r.reason}</div>}
      {r.outputTail && <pre className="out">{r.outputTail}</pre>}
      {r.logPath && <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>{r.logPath}</div>}
    </details>
  );
}

/**
 * The literal checklist. Every line here came from a command that was
 * actually run, by the agent's tool or by the button below. The agent's
 * prose never feeds it.
 */
export function VerificationPanel() {
  const s = useActiveSession();
  const verification = useUi((st) => st.verification);
  const v = s ? verification[s.id] : undefined;
  const [busy, setBusy] = useState<"detect" | "run" | null>(null);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    if (s && !verification[s.id]?.loaded) store.loadVerification(s.id).catch(() => {});
  }, [s?.id]);

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;

  const detect = async () => {
    setBusy("detect");
    try {
      await api.detectVerification(s.id);
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const run = async (checks?: { command: string }[]) => {
    setBusy("run");
    try {
      await api.runVerification(s.id, checks ? { checks } : { useDetected: true });
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const running = v?.running ?? {};
  const inFlight = Object.values(running).some((x) => x === "running");
  const detected = v?.detected;

  return (
    <div className="panel">
      <h2>Verification</h2>
      <div className="row">
        <button className="btn sm" disabled={busy !== null} onClick={detect}>{busy === "detect" ? "Detecting…" : "Detect project checks"}</button>
        <button className="btn primary sm" disabled={busy !== null || inFlight} onClick={() => run()}>{busy === "run" || inFlight ? "Running…" : "Run detected set"}</button>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input type="text" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="or a specific command, e.g. npm test -- --grep parser" onKeyDown={(e) => e.key === "Enter" && custom.trim() && (run([{ command: custom.trim() }]), setCustom(""))} />
      </div>

      {detected && (
        <>
          <h3>Detected ({detected.manifests.join(", ") || "no manifest"})</h3>
          {detected.checks.length === 0 && <div className="muted">No candidate checks found in machine-readable config.</div>}
          {detected.checks.map((c) => (
            <div key={c.id} className="check" style={{ fontSize: 12 }}>
              <span className={`st ${running[c.id] === "running" ? "running" : ""}`}>{running[c.id] === "running" ? "RUNNING" : c.kind}</span>
              <code>{c.command}</code>
              {c.mayModify && <span className="tag warn">modifies files</span>}
              {c.heavy && <span className="tag">heavy</span>}
            </div>
          ))}
          {detected.toolchain.length > 0 && (
            <>
              <h3>Toolchain pins</h3>
              {detected.toolchain.map((t, i) => (
                <div key={i} style={{ fontSize: 12 }}>
                  {t.tool}: pinned <code>{t.pinned}</code> · local <code>{t.local ?? "not found"}</code> <span className="faint">({t.source})</span>
                </div>
              ))}
            </>
          )}
        </>
      )}

      <h3>Runs</h3>
      {(!v || v.runs.length === 0) && <div className="empty">Nothing has been run yet. Until it has, nothing is verified.</div>}
      {v?.runs.map((r) => (
        <div key={r.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className={`tag ${r.allPassed ? "ok" : "bad"}`}>{r.allPassed ? "all passed" : "not all passed"}</span>
            <span className="faint">{new Date(r.ranAt).toLocaleTimeString()} · {r.results.length} checks</span>
          </div>
          <div className="stack" style={{ marginTop: 6, gap: 4 }}>
            {r.results.map((x) => (
              <Result key={x.id} r={x} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
