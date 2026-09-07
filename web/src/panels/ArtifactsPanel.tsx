import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { renderMarkdown } from "../markdown.js";
import { store, useActiveSession, useLastEvent } from "../store.js";
import type { ArtifactEntry, FileContent } from "../types.js";

const LETTERS: Record<string, string> = { A: "Recon Notes", B: "Triage Record", C: "The Fix", D: "Glossary", E: "Submission", F: "Feedback Log" };

function letterOf(name: string): string | null {
  const lead = /^([a-f])[-_ .]/i.exec(name)?.[1]?.toUpperCase();
  if (lead) return lead;
  const n = name.toLowerCase();
  if (/recon/.test(n)) return "A";
  if (/triage/.test(n)) return "B";
  if (/\bfix\b|fix-|fix_/.test(n)) return "C";
  if (/glossary/.test(n)) return "D";
  if (/submission|pull-request|pr-draft|pr_draft/.test(n)) return "E";
  if (/feedback/.test(n)) return "F";
  return null;
}

/**
 * Artifacts A-F, rendered from the artifact home and refreshed live from
 * the server's watcher. Files are the agent's; this only reads them.
 */
export function ArtifactsPanel() {
  const s = useActiveSession();
  const [entries, setEntries] = useState<ArtifactEntry[]>([]);
  const [home, setHome] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [find, setFind] = useState("");

  // The watcher's `artifacts` events carry the fresh listing.
  const lastArtifactsEvent = useLastEvent(s?.id, "artifacts");

  useEffect(() => {
    if (!s) return;
    api.artifacts(s.id).then((r) => { setEntries(r.entries.filter((e) => !e.isDir)); setHome(r.artifactHome); }).catch(() => {});
  }, [s?.id]);
  useEffect(() => {
    if (!lastArtifactsEvent) return;
    const d = lastArtifactsEvent.data as { artifactHome: string; entries: ArtifactEntry[] };
    setEntries(d.entries.filter((e) => !e.isDir));
    setHome(d.artifactHome);
  }, [lastArtifactsEvent?.seq]);

  const selectedEntry = entries.find((e) => e.name === selected);
  useEffect(() => {
    if (!s || !selected) return setFile(null);
    api.artifactFile(s.id, selected).then((r) => setFile(r.file)).catch((e) => store.toast(e.message));
  }, [s?.id, selected, selectedEntry?.modified]);

  useEffect(() => {
    if (!selected && entries.length) setSelected(entries[0].name);
    if (selected && !entries.some((e) => e.name === selected)) setSelected(entries[0]?.name ?? null);
  }, [entries.length]);

  const html = useMemo(() => {
    if (!file || file.binary) return "";
    const md = /\.(md|markdown|txt)$/i.test(file.path) ? file.content : "```\n" + file.content + "\n```";
    let out = renderMarkdown(md);
    const q = find.trim();
    if (q) {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?![^<]*>)(${esc})`, "gi"), "<mark>$1</mark>");
    }
    return out;
  }, [file, find]);

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;
  return (
    <div className="art">
      <div className="art-side">
        <div className="faint" style={{ padding: "6px 8px", fontSize: 11 }} title={home}>{home.split(/[\\/]/).slice(-2).join("/")}</div>
        {entries.length === 0 && <div className="empty" style={{ padding: 8 }}>No artifacts written yet.</div>}
        {entries.filter((e) => !e.name.startsWith("snapshots/")).map((e) => {
          const L = letterOf(e.name);
          return (
            <div key={e.name} className={`art-item${e.name === selected ? " sel" : ""}`} onClick={() => setSelected(e.name)} title={`${e.bytes} bytes · ${new Date(e.modified).toLocaleString()}`}>
              {L && <span className="tag bloom">{L}</span>}
              <span className="grow art-name">{L && LETTERS[L] ? LETTERS[L] : e.name}</span>
            </div>
          );
        })}
        {entries.some((e) => e.name.startsWith("snapshots/")) && (
          <>
            <div className="faint" style={{ padding: "8px 8px 2px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>Session snapshots</div>
            {entries.filter((e) => e.name.startsWith("snapshots/")).map((e) => (
              <div key={e.name} className={`art-item${e.name === selected ? " sel" : ""}`} onClick={() => setSelected(e.name)} title={`${e.bytes} bytes · ${new Date(e.modified).toLocaleString()}`}>
                <span className="tag">S</span>
                <span className="grow art-name">{new Date(e.modified).toLocaleString()}</span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="art-main">
        <div className="art-head">
          <span className="mono faint art-title" title={selected ?? ""}>{selected ?? ""}{file ? ` · ${new Date(file.modified).toLocaleTimeString()}` : ""}</span>
          <input type="text" value={find} onChange={(e) => setFind(e.target.value)} placeholder="find in this artifact" />
        </div>
        {!file && selected && <div className="empty" style={{ padding: 12 }}>Loading…</div>}
        {file && <div className="md" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  );
}
