import { useEffect, useState } from "react";
import { askConfirm, askPrompt } from "../ask.js";
import { api } from "../api.js";
import { store, useUi } from "../store.js";

export function SessionPanel() {
  const sessions = useUi((st) => st.sessions);
  const activeSessionId = useUi((st) => st.activeSessionId);
  const [repoDir, setRepoDir] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [model, setModel] = useState("");
  const [artifactHome, setArtifactHome] = useState("");
  const [preflight, setPreflight] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ name: string; artifactHome: string; modified: string; repoDir: string | null; repoDirSource?: string | null }[]>([]);

  const loadProjects = () => api.projects().then((p) => setProjects(p.projects)).catch(() => setProjects([]));
  useEffect(() => {
    void loadProjects();
  }, [sessions.length]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      store.toast(label);
      await loadProjects();
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    }
  };
  const renameProject = (name: string) => {
    const to = askPrompt(`Rename "${name}" to:`, name)?.trim();
    if (!to || to === name) return;
    void act(`Renamed to ${to}`, () => api.renameProject(name, to));
  };
  const moveProject = (name: string, from: string) => {
    const to = askPrompt(`Move the artifact folder for "${name}" to (full path of a new folder):`, from)?.trim();
    if (!to || to === from) return;
    void act(`Moved to ${to}`, () => api.moveProject(name, to));
  };
  const deleteProject = (name: string) => {
    if (!askConfirm(`Delete the artifact folder for "${name}" and everything in it (notes A–F, feedback log, benchmarks, snapshots)? This cannot be undone.`)) return;
    void act(`Deleted ${name}`, () => api.deleteProject(name));
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await store.createSession({ repoDir, repoUrl: repoUrl || undefined, model: model || undefined, artifactHome: artifactHome || undefined, preflight });
      setRepoDir("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack">
      <h2>Sessions</h2>
      {sessions.length === 0 && <div className="empty">No session yet. Point Mendophyte at a clone to begin.</div>}
      {sessions.map((s) => (
        <div key={s.id} className="card" style={{ borderColor: s.id === activeSessionId ? "var(--m-accent)" : undefined }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b title={s.repoDir}>{s.repoDir.split(/[\\/]/).pop()}</b>
            <span className={`tag ${s.status === "running" ? "ok" : s.status === "error" ? "bad" : ""}`}>{s.status}</span>
          </div>
          <div className="faint mono" style={{ fontSize: 11 }}>{s.repoDir}</div>
          <div className="row" style={{ marginTop: 6 }}>
            {s.preflight && <span className="tag accent">tier {s.preflight.tier}</span>}
            {s.lastState && <span className="tag">phase {s.lastState.phase}</span>}
            {s.model && <span className="tag">{s.model}</span>}
            {s.pendingApprovals > 0 && <span className="tag bad">{s.pendingApprovals} awaiting</span>}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {s.id !== activeSessionId && <button className="btn sm" onClick={() => store.setActive(s.id)}>Make active</button>}
            {s.status === "running" && <button className="btn sm" onClick={() => api.end(s.id).catch((e) => store.toast(e.message))}>End</button>}
            <button className="btn sm" onClick={() => askConfirm("Force-close and forget this session?") && api.remove(s.id).catch((e) => { if (/not found|404/i.test(e.message)) store.forgetSession(s.id); else store.toast(e.message); })}>Close</button>
          </div>
          {s.lastError && <div className="tag bad" style={{ marginTop: 6, whiteSpace: "normal", lineHeight: 1.4, padding: "6px 10px" }}>{s.lastError}</div>}
        </div>
      ))}

      {projects.length > 0 && (
        <>
          <h3>Prior projects (artifact homes)</h3>
          <div className="faint" style={{ marginBottom: 4 }}>One folder per repository: notes A–F, feedback log, benchmarks, snapshots.</div>
          <div className="proj-list">
            {projects.map((p) => {
              const live = sessions.some((s) => s.artifactHome === p.artifactHome && s.status !== "ended" && s.status !== "error");
              return (
                <div key={p.artifactHome} className="proj-row" title={p.artifactHome}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</b>
                      {live && <span className="tag ok">in use</span>}
                    </div>
                    <div className="faint mono" style={{ fontSize: "0.7rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.artifactHome}</div>
                  </div>
                  <span className="faint" style={{ whiteSpace: "nowrap" }}>{new Date(p.modified).toLocaleDateString()}</span>
                  <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                    <button className="btn sm" disabled={live} onClick={() => renameProject(p.name)} title="Rename the folder (stays under ~/.mendophyte)">Rename</button>
                    <button className="btn sm" disabled={live} onClick={() => moveProject(p.name, p.artifactHome)} title="Move the folder somewhere else on this machine">Move</button>
                    <button className="btn sm" disabled={live} onClick={() => deleteProject(p.name)} title="Delete the folder and everything in it">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <details className="sess-form" open={sessions.length === 0}>
        <summary><h3 style={{ display: "inline", margin: 0 }}>New session</h3> <span className="faint">point Mendophyte at a clone</span></summary>
      <label className="field">
        Repository clone (absolute path on this machine)
        <input type="text" value={repoDir} onChange={(e) => setRepoDir(e.target.value)} placeholder="/home/me/src/some-project" list="projects" />
        <datalist id="projects">
          {projects.map((p) => (
            <option key={p.artifactHome} value={p.name} />
          ))}
        </datalist>
      </label>
      <label className="field">
        Repository URL (only if the clone has no origin yet)
        <input type="text" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
      </label>
      <div className="row">
        <label className="field grow">
          Model (blank = your Claude Code default)
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="sonnet, opus, haiku, or a full model id" />
        </label>
        <label className="field grow">
          Artifact home (blank = ~/.mendophyte/&lt;repo&gt;)
          <input type="text" value={artifactHome} onChange={(e) => setArtifactHome(e.target.value)} />
        </label>
      </div>
      <label className="row" style={{ fontSize: 12 }}>
        <input type="checkbox" checked={preflight} onChange={(e) => setPreflight(e.target.checked)} /> Run Phase 0 pre-flight checks and hand them to the agent
      </label>
      {error && <div className="tag bad" style={{ whiteSpace: "normal", lineHeight: 1.4, padding: "6px 10px" }}>{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={!repoDir.trim() || busy} onClick={create}>
          {busy ? "Starting…" : "Start session"}
        </button>
        <span className="faint">Pre-flight can take up to 20s when a forge probe times out.</span>
      </div>

      </details>
    </div>
  );
}
