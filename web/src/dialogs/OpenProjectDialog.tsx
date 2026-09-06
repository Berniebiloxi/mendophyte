import { useEffect, useState } from "react";
import { askConfirm, askPrompt } from "../ask.js";
import { api } from "../api.js";
import { store } from "../store.js";
import { diag } from "../diag.js";
import type { ProjectInfo as Project } from "../types.js";

const SOURCE_HINT: Record<string, string> = {
  record: "",
  snapshot: "path recovered from a saved snapshot",
  benchmark: "path recovered from a benchmark run",
  guess: "found by name; check it before opening",
};

/**
 * Reopen a repository Mendophyte has worked on before. Each artifact home
 * remembers its clone (project.json); choosing one starts a new session
 * there, and the agent picks up from the artifacts it finds.
 */
export function OpenProjectDialog({ onClose, onOther }: { onClose: () => void; onOther: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.projects().then((p) => setProjects(p.projects)).catch((e) => { setErr(e.message); setProjects([]); });
  useEffect(() => {
    void load();
  }, []);
  const locate = async (p: Project) => {
    const guess = p.repoDir ?? "";
    const dir = askPrompt(`Where is the clone for "${p.name}"? Full path of the repository folder on this machine:`, guess)?.trim();
    if (!dir) return;
    setErr(null);
    try {
      await api.locateProject(p.name, dir);
      diag(`located project ${p.name} at ${dir}`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const open = async (p: Project) => {
    if (!p.repoDir) return;
    setBusy(p.name);
    setErr(null);
    try {
      diag(`open project ${p.name} (${p.repoDir})`);
      await store.createSession({ repoDir: p.repoDir, repoUrl: p.repoUrl ?? undefined, model: p.model ?? undefined, artifactHome: p.artifactHome, preflight: true });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="open-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plain">
        <div className="row modal-head" style={{ justifyContent: "space-between" }}>
          <h2 id="open-title">Open project</h2>
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body stack">
          <div className="muted">Repositories Mendophyte has worked on. Opening one starts a new session on that clone; the agent reads the notes it left there and asks how to continue.</div>
          {err && <span className="tag bad" style={{ whiteSpace: "normal" }}>{err}</span>}
          {projects === null && <div className="empty">Loading…</div>}
          {projects && projects.length === 0 && <div className="empty">Nothing yet. Start a session from the Session panel and it will appear here next time.</div>}
          {projects?.map((p) => (
            <div key={p.artifactHome} className="proj-row" title={p.artifactHome}>
              <div className="grow" style={{ minWidth: 0 }}>
                <b>{p.name}</b>
                <div className="faint mono" style={{ fontSize: "0.7rem", overflowWrap: "anywhere" }}>{p.repoDir ?? "clone path not known yet"}</div>
                {p.repoDirSource && p.repoDirSource !== "record" && <div className={`tag ${p.repoDirSource === "guess" ? "warn" : ""}`} style={{ marginTop: 2 }}>{SOURCE_HINT[p.repoDirSource]}</div>}
                {p.repoUrl && <div className="faint" style={{ fontSize: "0.7rem" }}>{p.repoUrl}</div>}
              </div>
              <span className="faint" style={{ whiteSpace: "nowrap" }}>{new Date(p.lastSessionAt ?? p.modified).toLocaleDateString()}</span>
              <button className="btn sm" disabled={busy !== null} onClick={() => locate(p)} title="Tell Mendophyte where this repository's clone is">{p.repoDir ? "Change…" : "Locate…"}</button>
              <button className="btn primary sm" disabled={!p.repoDir || busy !== null} onClick={() => open(p)} title={p.repoDir ? `Start a session on ${p.repoDir}` : "Use Locate… to point at the clone first"}>{busy === p.name ? "Starting…" : "Open"}</button>
            </div>
          ))}
        </div>
        <div className="modal-foot row" style={{ justifyContent: "space-between" }}>
          <span className="faint">Pre-flight runs again on open (a few seconds).</span>
          <button className="btn sm" onClick={() => { onOther(); onClose(); }}>Other folder… (Session panel)</button>
        </div>
      </div>
    </div>
  );
}
