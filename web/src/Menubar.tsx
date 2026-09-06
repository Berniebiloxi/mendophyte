import { useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview";
import { PANELS, buildDefaultLayout, deleteNamedLayout, loadNamedLayout, namedLayouts, newTerminal, saveNamedLayout, showPanel } from "./layout.js";
import { api as rest } from "./api.js";
import { store, useActiveSession, useUi } from "./store.js";

function Menu({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`menu${open ? " open" : ""}`} ref={ref}>
      <button onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div className="menu-list">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Menubar({ api }: { api: DockviewApi | null }) {
  const { connected, approvals, questions, theme, scheme, termFontSize } = useUi();
  const active = useActiveSession();
  const [layouts, setLayouts] = useState<string[]>(() => Object.keys(namedLayouts()));
  const refreshLayouts = () => setLayouts(Object.keys(namedLayouts()));

  return (
    <div className="menubar">
      <span className="wordmark" title="Mendophyte">
        <svg viewBox="0 0 120 64" aria-hidden="true">
          <path d="M4 56 C 30 56, 30 20, 56 20 S 90 44, 116 12" />
          <circle cx="56" cy="20" r="4" />
          <circle cx="90" cy="44" r="3.5" />
          <circle className="bloom" cx="116" cy="12" r="5" />
        </svg>
        Mendophyte
      </span>

      <Menu label="File">
        {(close) => (
          <>
            <button onClick={() => { api && showPanel(api, "session"); close(); }}>New session… <span className="kbd">Session panel</span></button>
            <button onClick={() => { api && showPanel(api, "session"); close(); }}>Open project… <span className="kbd">Session panel</span></button>
            <hr />
            <button disabled={!active} onClick={() => { active && rest.end(active.id).catch((e) => store.toast(e.message)); close(); }}>End session (finish turn, exit)</button>
            <button disabled={!active} onClick={() => { if (active && confirm("Force-close this session? Pending approvals are denied.")) rest.remove(active.id).catch((e) => store.toast(e.message)); close(); }}>Close session</button>
            <hr />
            <button disabled title="Snapshots come with the artifact panels">Save snapshot…</button>
            <button disabled title="Export comes with the artifact panels">Export…</button>
          </>
        )}
      </Menu>

      <Menu label="Edit">
        {(close) => (
          <>
            <button disabled={!active} onClick={() => { active && rest.interrupt(active.id).catch((e) => store.toast(e.message)); close(); }}>Interrupt agent</button>
            <button disabled>Find in artifacts…</button>
          </>
        )}
      </Menu>

      <Menu label="View">
        {(close) => (
          <>
            {PANELS.map((p) => (
              <button key={p.id} onClick={() => { api && showPanel(api, p.id); close(); }}>
                {p.title} {api?.getPanel(p.id) ? <span className="kbd">open</span> : null}
              </button>
            ))}
            <button onClick={() => { api && newTerminal(api); close(); }}>New terminal <span className="kbd">your shell in the clone</span></button>
            <hr />
            <button onClick={() => { api && buildDefaultLayout(api); close(); }}>Reset layout</button>
            <button onClick={() => { const n = prompt("Layout name"); if (n && api) { saveNamedLayout(api, n); refreshLayouts(); } close(); }}>Save layout as…</button>
            {layouts.map((n) => (
              <button key={n} onClick={() => { api && loadNamedLayout(api, n); close(); }}>
                Load “{n}”
                <span className="kbd" onClick={(e) => { e.stopPropagation(); deleteNamedLayout(n); refreshLayouts(); }} title="delete">✕</span>
              </button>
            ))}
            <hr />
            <button onClick={() => { store.setTheme("vine"); close(); }}>Theme: Vine {theme === "vine" ? <span className="kbd">●</span> : null}</button>
            <button onClick={() => { store.setTheme("minimal"); close(); }}>Theme: Minimal {theme === "minimal" ? <span className="kbd">●</span> : null}</button>
            <hr />
            {(["auto", "light", "dark"] as const).map((s) => (
              <button key={s} onClick={() => { store.setScheme(s); close(); }}>Scheme: {s} {scheme === s ? <span className="kbd">●</span> : null}</button>
            ))}
            <hr />
            <button onClick={() => store.setTermFontSize(termFontSize + 1)}>Terminal font larger <span className="kbd">{termFontSize}px</span></button>
            <button onClick={() => store.setTermFontSize(termFontSize - 1)}>Terminal font smaller</button>
          </>
        )}
      </Menu>

      <Menu label="Help">
        {(close) => (
          <>
            <button onClick={() => { window.open("https://github.com/anthropics/claude-agent-sdk-typescript", "_blank"); close(); }}>Agent SDK docs</button>
            <button onClick={() => { alert("Mendophyte 0.1.0\nLocal cockpit for AI-assisted open-source contribution work."); close(); }}>About</button>
          </>
        )}
      </Menu>

      <div className="menubar-status">
        {approvals.length > 0 && <span className="attention">{approvals.length} awaiting your confirmation</span>}
        {questions.length > 0 && <span className="attention" style={{ background: "var(--m-bloom)" }}>{questions.length} question{questions.length === 1 ? "" : "s"} for you</span>}
        {active && (
          <span title={active.repoDir}>
            {active.repoDir.split(/[\\/]/).pop()} · {active.status}
            {active.lastState ? ` · phase ${active.lastState.phase}` : ""}
          </span>
        )}
        <span title={connected ? "connected" : "reconnecting…"}>
          <span className={`dot ${connected ? "on" : "warn"}`} /> {connected ? "live" : "offline"}
        </span>
      </div>
    </div>
  );
}
