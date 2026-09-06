import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { store, useActiveSession, useLastEvent } from "../store.js";
import type { FeedbackEntry, FeedbackLog } from "../types.js";

/**
 * Artifact F: append-only, searchable, taggable. Entries are the durable
 * lessons from real feedback; the only mutation is flagging one as
 * possibly stale when live recon contradicts it.
 */
export function FeedbackPanel() {
  const s = useActiveSession();
  const [log, setLog] = useState<FeedbackLog | null>(null);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [lesson, setLesson] = useState("");
  const [tags, setTags] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  const lastLogEvent = useLastEvent(s?.id, "feedback_log");
  const lastArtifacts = useLastEvent(s?.id, "artifacts");

  const load = () => {
    if (!s) return;
    api.feedback(s.id).then((r) => setLog(r.log)).catch((e) => store.toast(e.message));
  };
  useEffect(() => {
    setLog(null);
    load();
  }, [s?.id]);
  useEffect(() => {
    if (lastLogEvent) setLog(lastLogEvent.data as FeedbackLog);
  }, [lastLogEvent?.seq]);
  // The agent may write the file directly; the artifact watcher tells us.
  useEffect(() => {
    if (lastArtifacts) load();
  }, [lastArtifacts?.seq]);

  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of log?.entries ?? []) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [log]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...(log?.entries ?? [])]
      .reverse()
      .filter((e) => !tag || e.tags.includes(tag))
      .filter((e) => !needle || `${e.lesson} ${e.source ?? ""} ${e.tags.join(" ")}`.toLowerCase().includes(needle));
  }, [log, q, tag]);

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;

  const add = async () => {
    if (!lesson.trim()) return;
    setBusy(true);
    try {
      const r = await api.addFeedback(s.id, { lesson: lesson.trim(), tags, source: source.trim() || undefined });
      setLog(r.log);
      setLesson("");
      setTags("");
      setSource("");
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleStale = async (e: FeedbackEntry) => {
    try {
      const r = await api.setFeedbackStale(s.id, e.id, !e.stale);
      setLog(r.log);
    } catch (err) {
      store.toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Feedback log</h2>
        <span className="faint" title={log?.path ?? ""}>{log ? `${log.entries.length} entr${log.entries.length === 1 ? "y" : "ies"}` : "…"}{log && !log.exists ? " · not created yet" : ""}</span>
      </div>
      <div className="faint" style={{ fontSize: 11, margin: "2px 0 8px" }}>Durable lessons from real feedback, not transcripts. Read on every resume; weighted above merged history. Append-only.</div>

      <div className="row">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search lessons, sources, tags" />
      </div>
      {tagCounts.length > 0 && (
        <div className="row" style={{ gap: 4, marginTop: 6 }}>
          {tagCounts.map(([t, n]) => (
            <span key={t} className={`tag${tag === t ? " accent" : ""}`} style={{ cursor: "pointer" }} onClick={() => setTag(tag === t ? null : t)}>
              #{t} <span className="faint">{n}</span>
            </span>
          ))}
        </div>
      )}

      <div className="stack" style={{ marginTop: 10 }}>
        {log && shown.length === 0 && <div className="empty">{log.entries.length ? "No entries match." : "No lessons recorded yet. The first real review comment usually produces one."}</div>}
        {shown.map((e) => (
          <div key={e.id} className={`card fb-entry${e.stale ? " stale" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="row" style={{ gap: 4 }}>
                <span className="faint mono" style={{ fontSize: 11 }}>{e.at.replace("T", " ").replace(/Z(-\d+Z)?$/, "")}</span>
                {e.tags.map((t) => (
                  <span key={t} className="tag" style={{ cursor: "pointer" }} onClick={() => setTag(t)}>#{t}</span>
                ))}
                {e.stale && <span className="tag warn">possibly stale</span>}
              </span>
              <button className="btn sm" onClick={() => toggleStale(e)} title={e.stale ? "live recon confirmed this again" : "live recon contradicts this entry"}>
                {e.stale ? "unflag" : "flag stale"}
              </button>
            </div>
            <div style={{ margin: "6px 0 2px", whiteSpace: "pre-wrap" }}>{e.lesson}</div>
            {e.source && <div className="faint" style={{ fontSize: 11 }}>Source: {e.source}</div>}
          </div>
        ))}
      </div>

      <h3>Add a lesson</h3>
      <textarea value={lesson} onChange={(e) => setLesson(e.target.value)} placeholder="What did real feedback teach about this project? One or a few sentences." onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && add()} />
      <div className="row" style={{ marginTop: 6 }}>
        <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags: conventions, tests, review" style={{ flex: 1 }} />
        <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="source: PR #482 review by @alice" style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={busy || !lesson.trim()} onClick={add}>Append</button>
      </div>
    </div>
  );
}
