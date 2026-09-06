import { useState } from "react";
import type { DockviewApi } from "dockview";
import { PRESETS, applyPreset, deleteNamedLayout, loadNamedLayout, namedLayouts, renameNamedLayout, saveNamedLayout } from "../layout.js";
import { store, useUi } from "../store.js";
import { diag } from "../diag.js";

/**
 * Presets for each part of the workflow, and the user's own saved layouts
 * (load, overwrite with the current arrangement, rename, delete). Layouts
 * live in this browser's localStorage.
 */
export function LayoutsDialog({ api, onClose }: { api: DockviewApi; onClose: () => void }) {
  const [names, setNames] = useState<string[]>(() => Object.keys(namedLayouts()));
  const [newName, setNewName] = useState("");
  const follow = useUi((st) => st.layoutFollowsPhase);
  const refresh = () => setNames(Object.keys(namedLayouts()));
  const save = () => {
    const n = newName.trim();
    if (!n) return;
    saveNamedLayout(api, n);
    diag(`layout saved "${n}"`);
    setNewName("");
    refresh();
    store.toast(`Saved layout “${n}”`);
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="layouts-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plain">
        <div className="row modal-head" style={{ justifyContent: "space-between" }}>
          <h2 id="layouts-title">Layouts</h2>
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body stack">
          <h3>Workflow presets</h3>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button key={p.id} className="preset" onClick={() => { applyPreset(api, p.id); diag(`layout preset ${p.id}`); onClose(); }}>
                <b>{p.title}</b>
                <span className="muted">{p.hint}</span>
                {p.phases.length > 0 && <span className="faint">phase {p.phases.join(", ")}</span>}
              </button>
            ))}
          </div>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={follow} onChange={(e) => store.setLayoutFollowsPhase(e.target.checked)} />
            Follow the phase: switch to the matching preset as the agent moves through the process
          </label>

          <h3>Your layouts</h3>
          <div className="row">
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="name for the current arrangement" onKeyDown={(e) => e.key === "Enter" && save()} />
            <button className="btn primary sm" disabled={!newName.trim()} onClick={save}>Save current</button>
          </div>
          {names.length === 0 && <div className="empty">No saved layouts yet. Arrange the panels, name it above, and save.</div>}
          {names.map((n) => (
            <div key={n} className="proj-row">
              <b className="grow">{n}</b>
              <button className="btn sm" onClick={() => { loadNamedLayout(api, n); diag(`layout load "${n}"`); onClose(); }}>Load</button>
              <button className="btn sm" title="Replace this saved layout with the current arrangement" onClick={() => { if (confirm(`Overwrite “${n}” with the current arrangement?`)) { saveNamedLayout(api, n); store.toast(`Updated “${n}”`); } }}>Overwrite</button>
              <button className="btn sm" onClick={() => { const to = prompt(`Rename “${n}” to:`, n)?.trim(); if (to && renameNamedLayout(n, to)) refresh(); else if (to) store.toast("That name is taken or empty"); }}>Rename</button>
              <button className="btn sm" onClick={() => { if (confirm(`Delete layout “${n}”?`)) { deleteNamedLayout(n); refresh(); } }}>Delete</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
