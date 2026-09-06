import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useActiveSession } from "../store.js";
import type { PreflightReport } from "../types.js";

const TIER: Record<string, { label: string; cls: string }> = {
  full: { label: "full forge access", cls: "ok" },
  partial: { label: "partial access", cls: "warn" },
  "local-only": { label: "local clone only", cls: "bad" },
};

const yn = (v: boolean | null) => (v === null ? <span className="faint">unobserved</span> : v ? "yes" : "no");

export function CapabilityPanel() {
  const s = useActiveSession();
  const [report, setReport] = useState<PreflightReport | null>(null);
  useEffect(() => {
    setReport(null);
    if (!s) return;
    api.preflight(s.id).then((r) => setReport(r.report)).catch(() => setReport(null));
  }, [s?.id]);

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;
  if (!report) return <div className="panel"><div className="empty">{s.preflight ? "Loading pre-flight…" : "Pre-flight was skipped for this session."}</div></div>;

  const cap = report.capability;
  const h = report.health;
  const t = TIER[cap.tier];
  return (
    <div className="panel">
      <h2>Capability</h2>
      <div className="row">
        <span className={`tag ${t.cls}`}>{t.label}</span>
        {cap.forge && <span className="tag">{cap.forge.kind} · {cap.forge.path}</span>}
      </div>
      <h3>Probes</h3>
      <dl className="kv">
        <dt>forge CLI</dt><dd>{cap.authCli.skipped ? <span className="faint">{cap.authCli.summary}</span> : cap.authCli.ok ? <span className="tag ok">{cap.authCli.summary}</span> : <span className="tag bad">{cap.authCli.summary}</span>}</dd>
        <dt>ls-remote</dt><dd>{cap.lsRemote.ok ? <span className="tag ok">{cap.lsRemote.summary}</span> : <span className="tag bad">{cap.lsRemote.summary}</span>}</dd>
        <dt>anonymous API</dt><dd>{cap.anonymousApi.skipped ? <span className="faint">{cap.anonymousApi.summary}</span> : cap.anonymousApi.ok ? <span className="tag ok">{cap.anonymousApi.summary}</span> : <span className="tag bad">{cap.anonymousApi.summary}</span>}</dd>
      </dl>
      {cap.notes.map((n, i) => <div key={i} className="muted" style={{ fontSize: 12, marginTop: 4 }}>{n}</div>)}

      <h3>Repo health</h3>
      {h.observed ? (
        <dl className="kv">
          <dt>exists</dt><dd>{yn(h.exists)}</dd>
          <dt>public</dt><dd>{yn(h.public)}</dd>
          <dt>archived</dt><dd>{h.archived ? <span className="tag bad">yes</span> : yn(h.archived)}</dd>
          <dt>mirror</dt><dd>{yn(h.mirror)}</dd>
          {h.defaultBranch && <><dt>default branch</dt><dd>{h.defaultBranch}</dd></>}
          {h.fork !== null && <><dt>fork</dt><dd>{h.fork ? `of ${h.forkOf ?? "?"}` : "no"}</dd></>}
          {h.openIssues !== null && <><dt>open issues</dt><dd>{h.openIssues}</dd></>}
          {h.lastActivity && <><dt>last activity</dt><dd>{h.lastActivity.slice(0, 10)}</dd></>}
        </dl>
      ) : (
        <div className="muted">Unobserved: {h.reason}</div>
      )}

      <h3>AI policy &amp; legal files</h3>
      {report.policy.files.length === 0 ? (
        <div className="muted">None of the candidate files exist.</div>
      ) : (
        report.policy.files.map((f) => (
          <details key={f.path}>
            <summary>
              <code>{f.path}</code> <span className="tag">{f.role}</span>{" "}
              {f.aiHits.length > 0 && <span className="tag warn">{f.aiHits.length} AI</span>} {f.legalHits.length > 0 && <span className="tag warn">{f.legalHits.length} CLA/DCO</span>}
            </summary>
            {[...f.aiHits.map((h) => ({ ...h, k: "AI" })), ...f.legalHits.map((h) => ({ ...h, k: "legal" }))].map((h, i) => (
              <div key={i} style={{ fontSize: 12, margin: "3px 0 3px 12px" }}>
                <span className="faint">{h.k} L{h.line}</span> {h.text}
              </div>
            ))}
          </details>
        ))
      )}

      <h3>Local</h3>
      <dl className="kv">
        <dt>branch</dt><dd>{report.git.branch ?? "?"} @ {report.git.head ?? "?"}{report.git.upstream ? ` (upstream ${report.git.upstream})` : ""}</dd>
        <dt>working tree</dt><dd>{report.git.dirtyFiles === 0 ? "clean" : `${report.git.dirtyFiles ?? "?"} changed paths`}</dd>
        <dt>scale</dt><dd>{report.scale.trackedFiles ?? "?"} tracked files{report.scale.topExtensions.length ? ` · ${report.scale.topExtensions.slice(0, 4).map(([e, n]) => `${e} ${n}`).join(", ")}` : ""}</dd>
        <dt>machine</dt><dd>{report.environment.platform} {report.environment.arch} · {report.environment.cpuCount} CPU · {report.environment.totalMemGb} GB{report.environment.wsl ? " · WSL" : ""}{report.environment.container ? " · container" : ""}</dd>
        <dt>artifacts</dt><dd>{report.artifacts.entries.length ? `${report.artifacts.entries.length} present` : "none yet"}</dd>
      </dl>
    </div>
  );
}
