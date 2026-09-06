import { useEffect, useState } from "react";
import { api } from "../api.js";
import { store, useActiveSession, useLastEvent } from "../store.js";
import type { CiStatus, SubmissionReport } from "../types.js";

/**
 * Artifact E's dashboard: the PR, CI polled from the forge on a timer,
 * template compliance as a per-item check, sign-off and branch sync. Every
 * line is observed or labelled unobserved; none of it comes via the model.
 */

const CI_CLS: Record<CiStatus, string> = { success: "ok", failure: "bad", pending: "warn", neutral: "", skipped: "", cancelled: "warn", unknown: "" };
const CI_GLYPH: Record<CiStatus, string> = { success: "✓", failure: "✗", pending: "…", neutral: "–", skipped: "↷", cancelled: "⊘", unknown: "?" };

export function SubmissionPanel() {
  const s = useActiveSession();
  const [report, setReport] = useState<SubmissionReport | null>(null);
  const [polling, setPolling] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const lastEvent = useLastEvent(s?.id, "submission");

  useEffect(() => {
    setReport(null);
    setErr(null);
    if (!s) return;
    api.submission(s.id).then((r) => { setReport(r.report); setPolling(r.pollingSec); }).catch((e) => setErr(e.message));
  }, [s?.id]);
  useEffect(() => {
    if (lastEvent) setReport(lastEvent.data as SubmissionReport);
  }, [lastEvent?.seq]);

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;

  const refresh = async (fetch: boolean) => {
    setBusy(fetch ? "fetch" : "refresh");
    try {
      const r = await api.refreshSubmission(s.id, fetch);
      setReport(r.report);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const setPoll = async (sec: number | null) => {
    try {
      const r = await api.pollSubmission(s.id, sec);
      setPolling(r.pollingSec);
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    }
  };

  const r = report;
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Submission</h2>
        <span className="row">
          <button className="btn sm" disabled={busy !== null} onClick={() => refresh(false)}>{busy === "refresh" ? "…" : "Refresh"}</button>
          <button className="btn sm" disabled={busy !== null} onClick={() => refresh(true)} title="git fetch the base remote, then recompute ahead/behind">{busy === "fetch" ? "fetching…" : "Fetch & check sync"}</button>
          <select value={polling ?? ""} onChange={(e) => setPoll(e.target.value ? Number(e.target.value) : null)} title="poll the forge for PR and CI changes" style={{ width: "auto" }}>
            <option value="">no polling</option>
            <option value="30">every 30s</option>
            <option value="60">every 60s</option>
            <option value="300">every 5 min</option>
          </select>
        </span>
      </div>
      {err && <div className="tag bad" style={{ marginTop: 6 }}>{err}</div>}
      {!r && !err && <div className="empty">Computing…</div>}
      {r && (
        <>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            branch <code>{r.branch ?? "?"}</code> @ {r.head?.slice(0, 7)} · {r.baseRepo ? `${r.baseRepo.path} on ${r.baseRepo.host}` : "no forge remote"} · checked {new Date(r.ranAt).toLocaleTimeString()}{polling ? ` · polling every ${polling}s` : ""}
          </div>

          <h3>Pull request</h3>
          {r.pr ? (
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <a href={r.pr.url} target="_blank" rel="noreferrer"><b>#{r.pr.number}</b> {r.pr.title}</a>
                <span className="row">
                  <span className={`tag ${r.pr.state === "MERGED" ? "ok" : r.pr.state === "CLOSED" ? "bad" : "accent"}`}>{r.pr.state.toLowerCase()}{r.pr.isDraft ? " · draft" : ""}</span>
                </span>
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
                {r.pr.headRef} → {r.pr.baseRef} · by {r.pr.author ?? "?"} · review {r.pr.reviewDecision ?? "none yet"} · mergeable {r.pr.mergeable ?? "unobserved"}
                {r.pr.labels.length ? ` · ${r.pr.labels.join(", ")}` : ""}
              </div>
            </div>
          ) : r.prObserved ? (
            <div className="muted">{r.prReason} <span className="faint">(observed via {r.prSource})</span></div>
          ) : (
            <div className="muted"><span className="tag unobs">unobserved</span> {r.prReason}</div>
          )}

          <h3>CI {r.ci.overall && <span className={`tag ${CI_CLS[r.ci.overall]}`}>{r.ci.overall}</span>}</h3>
          {!r.ci.observed && <div className="muted"><span className="tag unobs">unobserved</span> {r.ci.reason}</div>}
          {r.ci.observed && r.ci.checks.length === 0 && <div className="muted">{r.ci.reason ?? "no checks for this commit"}</div>}
          {r.ci.checks.map((c, i) => (
            <div key={i} className="check" style={{ fontSize: 12 }}>
              <span className={`st ${c.status === "success" ? "passed" : c.status === "failure" ? "failed" : c.status === "pending" ? "running" : ""}`}>{CI_GLYPH[c.status]} {c.status}</span>
              {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : <span>{c.name}</span>}
              <span className="faint">{c.completedAt ? new Date(c.completedAt).toLocaleTimeString() : ""}</span>
            </div>
          ))}
          {r.ci.observed && <div className="faint" style={{ fontSize: 11 }}>source: {r.ci.source}</div>}

          <h3>Template compliance {r.template.templatePath && <span className={`tag ${r.template.missing || r.template.unchecked ? "warn" : "ok"}`}>{r.template.missing} missing · {r.template.unchecked} unchecked</span>}</h3>
          {!r.template.templatePath && <div className="muted">{r.template.reason}</div>}
          {r.template.templatePath && (
            <>
              <div className="faint" style={{ fontSize: 11 }}>
                template <code>{r.template.templatePath}</code> vs {r.template.draftSource === "pr-body" ? "the PR body" : r.template.draftSource === "artifact" ? <>Artifact E <code>{r.template.draftPath?.split(/[\\/]/).pop()}</code></> : "nothing yet"}
                {r.template.reason ? ` · ${r.template.reason}` : ""}
              </div>
              {r.template.items.map((it, i) => (
                <div key={i} className="check" style={{ fontSize: 12 }}>
                  <span className={`st ${it.present ? (it.kind === "checkbox" && it.checked === false ? "timeout" : "passed") : "failed"}`}>
                    {it.present ? (it.kind === "checkbox" ? (it.checked ? "[x]" : "[ ]") : "✓") : "missing"}
                  </span>
                  <span className={it.kind === "heading" ? "" : "muted"}>{it.kind === "heading" ? <b>{it.text}</b> : it.text}</span>
                </div>
              ))}
            </>
          )}

          <h3>Legal gate</h3>
          <dl className="kv">
            <dt>DCO / sign-off</dt>
            <dd>{r.legal.dcoRequired ? <span className="tag warn">required</span> : <span className="tag">no evidence it's required</span>} <span className="faint">{r.legal.evidence}</span></dd>
            <dt>branch commits</dt>
            <dd>{r.legal.commitsChecked} checked · {r.legal.signedOff} signed off{r.legal.unsigned.length ? <>; unsigned: <code>{r.legal.unsigned.join("; ")}</code></> : ""}</dd>
          </dl>

          <h3>Branch sync</h3>
          <dl className="kv">
            <dt>upstream</dt><dd>{r.sync.upstream ?? <span className="faint">none set</span>}{r.sync.unpushed !== null ? ` · ${r.sync.unpushed} unpushed` : ""}</dd>
            <dt>vs base</dt>
            <dd>
              {r.sync.baseRemote && r.sync.baseBranch ? <code>{r.sync.baseRemote}/{r.sync.baseBranch}</code> : <span className="faint">base unknown</span>}
              {r.sync.aheadOfBase !== null ? ` · ahead ${r.sync.aheadOfBase}, behind ${r.sync.behindBase}` : ""}
              {r.sync.behindBase ? <span className="tag warn" style={{ marginLeft: 6 }}>sync before opening (5E)</span> : null}
              <span className="faint"> {r.sync.fetched ? "(after fetch)" : "(local refs, not fetched)"}</span>
              {r.sync.reason ? <div className="faint">{r.sync.reason}</div> : null}
            </dd>
          </dl>
          {r.notes.map((n, i) => <div key={i} className="faint" style={{ fontSize: 11 }}>note: {n}</div>)}
        </>
      )}
    </div>
  );
}
