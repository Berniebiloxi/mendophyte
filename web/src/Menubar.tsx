import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { askConfirm, askPrompt } from "./ask.js";
import type { DockviewApi } from "dockview";
import { PANELS, PRESETS, applyPreset, loadNamedLayout, namedLayouts, newTerminal, showPanel } from "./layout.js";
import { OpenProjectDialog } from "./dialogs/OpenProjectDialog.js";
import { LayoutsDialog } from "./dialogs/LayoutsDialog.js";
import { api as rest } from "./api.js";
import { UI_SCALE_STEPS, autoUiScale, effectiveFonts, isWindows, store, useActiveSession, useUi } from "./store.js";
import { diag } from "./diag.js";

/** A checkmark that does not depend on the system font having the glyph. */
function Check({ on }: { on: boolean }) {
  return (
    <span className="check" aria-hidden="true">
      {on && (
        <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 6.5 L5 9.2 L10 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      )}
    </span>
  );
}

/**
 * A flyout inside a menu. Only one flyout is open per menu (the parent
 * holds which), so moving the pointer from one row to the next switches
 * instantly instead of waiting for the previous flyout's close timer.
 */
const SubMenuCtx = createContext<{ open: string | null; setOpen: (k: string | null) => void }>({ open: null, setOpen: () => {} });

function SubMenu({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  const { open, setOpen } = useContext(SubMenuCtx);
  const isOpen = open === label;
  return (
    <div className={`submenu${isOpen ? " open" : ""}`} onMouseEnter={() => setOpen(label)}>
      <button type="button" aria-haspopup="menu" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : label)}>
        <span>{label}</span>
        <span className="kbd">{hint}<span className="chev">›</span></span>
      </button>
      {isOpen && <div className="menu-list sub" role="menu">{children}</div>}
    </div>
  );
}

/** Which top-level menu is open lives on the bar, so hovering another label while one is open switches at once. */
const MenubarCtx = createContext<{ open: string | null; setOpen: (k: string | null) => void }>({ open: null, setOpen: () => {} });

function Menu({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const bar = useContext(MenubarCtx);
  const open = bar.open === label;
  const [sub, setSub] = useState<string | null>(null);
  const subCtx = useMemo(() => ({ open: sub, setOpen: setSub }), [sub]);
  const close = () => { bar.setOpen(null); setSub(null); };
  return (
    <div className={`menu${open ? " open" : ""}`}>
      <button
        onClick={() => { bar.setOpen(open ? null : label); setSub(null); }}
        onMouseEnter={() => { if (bar.open !== null && bar.open !== label) { bar.setOpen(label); setSub(null); } }}
      >
        {label}
      </button>
      {open && (
        <SubMenuCtx.Provider value={subCtx}>
          <div className="menu-list" onMouseLeave={() => setSub(null)}>{children(close)}</div>
        </SubMenuCtx.Provider>
      )}
    </div>
  );
}

export function Menubar({ api }: { api: DockviewApi | null }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barCtx = useMemo(() => ({ open: openMenu, setOpen: setOpenMenu }), [openMenu]);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => { if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenMenu(null);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [openMenu]);
  const [dialog, setDialog] = useState<"open" | "layouts" | null>(null);
  const connected = useUi((st) => st.connected);
  const nApprovals = useUi((st) => st.approvals.length);
  const nQuestions = useUi((st) => st.questions.length);
  const theme = useUi((st) => st.theme);
  const scheme = useUi((st) => st.scheme);
  const termFontSize = useUi((st) => st.termFontSize);
  const uiScale = useUi((st) => st.uiScale);
  const followPhase = useUi((st) => st.layoutFollowsPhase);
  const fonts = useUi((st) => st.fonts);
  // Integer device pixel ratios are OS scaling; anything else means the browser's own zoom is on.
  const dpr = window.devicePixelRatio || 1;
  const browserZoom = Number.isInteger(dpr) ? null : `${Math.round(dpr * 100)}%`;
  // Re-render when panels open/close so the checkmarks stay honest.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!api) return;
    const a = api.onDidAddPanel(() => bump((n) => n + 1));
    const r = api.onDidRemovePanel(() => bump((n) => n + 1));
    return () => { a.dispose(); r.dispose(); };
  }, [api]);
  const togglePanel = (id: (typeof PANELS)[number]["id"]) => {
    if (!api) return;
    const p = api.getPanel(id);
    if (p) { diag(`close panel ${id}`); p.api.close(); }
    else showPanel(api, id);
  };
  const openCount = api ? PANELS.filter((p) => api.getPanel(p.id)).length : 0;
  const active = useActiveSession();
  const layoutsCount = Object.keys(namedLayouts()).length;
  const busy = !!active?.busy && active.status === "running";
  const interrupt = async () => {
    if (!active) return;
    try {
      diag("interrupt requested from Edit menu");
      const r = await rest.interrupt(active.id);
      store.toast(r.wasBusy ? "Interrupt sent. The agent stops at its next step; anything it was waiting on is dismissed." : "Nothing to interrupt: the agent is idle.");
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <MenubarCtx.Provider value={barCtx}>
    {dialog === "open" && <OpenProjectDialog onClose={() => setDialog(null)} onOther={() => api && showPanel(api, "session")} />}
    {dialog === "layouts" && api && <LayoutsDialog api={api} onClose={() => setDialog(null)} />}
    <div className="menubar" ref={barRef}>
      <span className="wordmark" title={`Mendophyte ${__MENDOPHYTE_VERSION__}`}>
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
            <button onClick={() => { setDialog("open"); close(); }}>Open project… <span className="kbd">a repo you worked on before</span></button>
            <hr />
            <button disabled={!active || active.status !== "running"} title={active?.status === "ended" ? "Already ended" : "Let the agent finish its turn, then exit"} onClick={() => { if (active) rest.end(active.id).then(() => store.toast("Ending: the agent finishes its turn and exits.")).catch((e) => store.toast(e.message)); close(); }}>
              End session <span className="kbd">{active ? active.status : "no session"}</span>
            </button>
            <button disabled={!active} onClick={() => { if (active && askConfirm("Force-close this session? Pending approvals are denied.")) rest.remove(active.id).catch((e) => store.toast(e.message)); close(); }}>Close session</button>
            <hr />
            <button disabled={!active} title="Write a Markdown record of this session (conversation, state, verification, submission) into the artifact home under snapshots/" onClick={() => { if (active) rest.snapshot(active.id).then((r) => store.toast(`Snapshot saved: ${r.path}`)).catch((e) => store.toast(e.message)); close(); }}>
              Save snapshot <span className="kbd">to artifact home</span>
            </button>
            <button disabled={!active} title="Download the same record as a .md file" onClick={() => { if (active) { diag("export snapshot"); window.open(`/api/sessions/${active.id}/snapshot.md`, "_blank"); } close(); }}>
              Export session… <span className="kbd">.md download</span>
            </button>
            <hr />
            <button title="Stop the Mendophyte server and free its port. Sessions end; artifacts stay on disk." onClick={() => { if (askConfirm("Quit Mendophyte? The server stops and its port is freed. Running sessions end (their notes stay in the artifact home).")) void store.quit(); close(); }}>
              Quit Mendophyte <span className="kbd">stops the server</span>
            </button>
          </>
        )}
      </Menu>

      <Menu label="Edit">
        {(close) => (
          <>
            <button disabled={!busy} title={!active ? "No session" : busy ? "Stop the agent's current turn; it keeps the session and waits for your next message" : "The agent is idle: there is no turn to interrupt"} onClick={() => { void interrupt(); close(); }}>
              Interrupt agent <span className="kbd">{!active ? "no session" : busy ? "working" : "idle"}</span>
            </button>
            <button disabled={!active} onClick={() => { if (api) { showPanel(api, "artifacts"); setTimeout(() => (document.querySelector('input[placeholder="find in this artifact"]') as HTMLInputElement | null)?.focus(), 50); } close(); }}>Find in artifacts… <span className="kbd">Artifacts panel</span></button>
          </>
        )}
      </Menu>

      <Menu label="View">
        {(close) => (
          <>
            <SubMenu label="Panels" hint={`${openCount}/${PANELS.length} open`}>
              {PANELS.map((p) => {
                const open = !!api?.getPanel(p.id);
                return (
                  <button key={p.id} role="menuitemcheckbox" aria-checked={open} className={open ? "checked" : ""} onClick={() => togglePanel(p.id)}>
                    <span><Check on={open} />{p.title}</span>
                  </button>
                );
              })}
              <hr />
              <button onClick={() => { api && newTerminal(api); close(); }}><span><Check on={false} />New terminal</span> <span className="kbd">your shell in the clone</span></button>
            </SubMenu>
            <SubMenu label="Layout" hint={layoutsCount ? `${layoutsCount} saved` : undefined}>
              {PRESETS.map((p) => (
                <button key={p.id} onClick={() => { api && applyPreset(api, p.id); diag(`layout preset ${p.id}`); close(); }}>
                  <span>{p.title}</span> <span className="kbd">{p.hint}</span>
                </button>
              ))}
              <hr />
              <button role="menuitemcheckbox" aria-checked={followPhase} onClick={() => store.setLayoutFollowsPhase(!followPhase)}><span><Check on={followPhase} />Follow the phase</span></button>
              <hr />
              {Object.keys(namedLayouts()).map((n) => (
                <button key={n} onClick={() => { api && loadNamedLayout(api, n); diag(`layout load "${n}"`); close(); }}>Load “{n}”</button>
              ))}
              <button onClick={() => { setDialog("layouts"); close(); }}>Manage layouts… <span className="kbd">save, rename, delete</span></button>
            </SubMenu>
            <SubMenu label="Appearance" hint={`${theme} · ${scheme} · ${effectiveFonts(fonts)} fonts`}>
              <button onClick={() => { store.setTheme("vine"); close(); }}><span><Check on={theme === "vine"} />Theme: Vine</span></button>
              <button onClick={() => { store.setTheme("minimal"); close(); }}><span><Check on={theme === "minimal"} />Theme: Minimal</span></button>
              <hr />
              {(["auto", "light", "dark"] as const).map((s) => (
                <button key={s} onClick={() => { store.setScheme(s); close(); }}><span><Check on={scheme === s} />Scheme: {s}</span></button>
              ))}
              <hr />
              <button onClick={() => { store.setFonts("auto"); close(); }}><span><Check on={fonts === "auto"} />Fonts: auto</span> <span className="kbd">{isWindows() ? "bundled on Windows" : "system here"}</span></button>
              <button onClick={() => { store.setFonts("system"); close(); }}><span><Check on={fonts === "system"} />Fonts: this computer's</span></button>
              <button onClick={() => { store.setFonts("bundled"); close(); }}><span><Check on={fonts === "bundled"} />Fonts: bundled</span> <span className="kbd">Inter · Source Serif · JetBrains Mono</span></button>
            </SubMenu>
            <SubMenu label="UI size" hint={`${uiScale === "auto" ? `auto · ${Math.round(autoUiScale() * 100)}%` : `${Math.round(uiScale * 100)}%`}${browserZoom ? ` · zoom ${browserZoom}` : ""}`}>
              {browserZoom && (
                <div className="faint" style={{ padding: "0.3rem 0.6rem", maxWidth: "16rem", whiteSpace: "normal" }}>
                  The browser's own zoom is at {browserZoom} for this site (Ctrl/Cmd+0 resets it). UI size applies on top of it, and Auto sees the zoomed screen width.
                </div>
              )}
              <button onClick={() => { store.setUiScale("auto"); close(); }}><span><Check on={uiScale === "auto"} />Auto for this screen</span> <span className="kbd">{Math.round(autoUiScale() * 100)}%</span></button>
              <hr />
              {UI_SCALE_STEPS.map((sc) => (
                <button key={sc} onClick={() => { store.setUiScale(sc); close(); }}><span><Check on={uiScale === sc} />{Math.round(sc * 100)}%</span></button>
              ))}
            </SubMenu>
            <SubMenu label="Terminal font" hint={`${termFontSize}px`}>
              <button onClick={() => store.setTermFontSize(termFontSize + 1)}>Larger</button>
              <button onClick={() => store.setTermFontSize(termFontSize - 1)}>Smaller</button>
              <button onClick={() => store.setTermFontSize(13)}>Reset to 13px</button>
            </SubMenu>
          </>
        )}
      </Menu>

      <Menu label="Help">
        {(close) => (
          <>
            <button role="menuitemcheckbox" aria-checked={!!api?.getPanel("debug")} onClick={() => { togglePanel("debug"); close(); }}><span><Check on={!!api?.getPanel("debug")} />Debug log</span> <span className="kbd">for bug reports</span></button>
            <hr />
            <button onClick={() => { window.open("https://github.com/anthropics/claude-agent-sdk-typescript", "_blank"); close(); }}>Agent SDK docs</button>
            <button onClick={() => { alert(`Mendophyte ${__MENDOPHYTE_VERSION__}\nLocal cockpit for AI-assisted open-source contribution work.`); close(); }}>About</button>
          </>
        )}
      </Menu>

      <div className="menubar-status">
        {nApprovals > 0 && <span className="attention">{nApprovals} awaiting your confirmation</span>}
        {nQuestions > 0 && <span className="attention bloom">{nQuestions} question{nQuestions === 1 ? "" : "s"} for you</span>}
        {active?.busy && active.status === "running" && (
          <span className="working" title="The agent is working on a reply"><span className="leaves sm"><i /><i /><i /></span> working</span>
        )}
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
    </MenubarCtx.Provider>
  );
}
