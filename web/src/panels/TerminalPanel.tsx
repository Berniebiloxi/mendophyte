import { useEffect, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "../api.js";
import { store, useActiveSession, useUi } from "../store.js";
import { diag } from "../diag.js";

/**
 * Your shell, in the clone. Not the agent's session: nothing typed here is
 * gated or observed. Output survives reloads via the server's scrollback.
 */

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function xtermTheme(dark: boolean): ITheme {
  const light = {
    black: "#3b4038", red: "#9b3b2e", green: "#2f5138", yellow: "#a86a12", blue: "#2a5d8a", magenta: "#7a4b7c", cyan: "#1f6f69", white: "#c9c3ad",
    brightBlack: "#7c8473", brightRed: "#c2513f", brightGreen: "#3d6b48", brightYellow: "#c9a227", brightBlue: "#3f7bb0", brightMagenta: "#9a63a0", brightCyan: "#2a8f88", brightWhite: "#f3efe3",
  };
  const darkP = {
    black: "#1e241d", red: "#e07a68", green: "#7fb28a", yellow: "#e0bc48", blue: "#6ea0ea", magenta: "#c79bd0", cyan: "#66b5ad", white: "#adb8a5",
    brightBlack: "#5b6656", brightRed: "#f09484", brightGreen: "#97c69f", brightYellow: "#f0d070", brightBlue: "#8ab4f0", brightMagenta: "#dbb3e2", brightCyan: "#84d0c8", brightWhite: "#e8e6dc",
  };
  return {
    background: css("--m-code-bg") || (dark ? "#1b201a" : "#eee9d9"),
    foreground: css("--m-ink") || (dark ? "#e8e6dc" : "#23271f"),
    cursor: css("--m-accent") || "#2f5138",
    cursorAccent: css("--m-panel") || "#fff",
    selectionBackground: css("--m-selection") || "rgba(61,107,72,0.25)",
    ...(dark ? darkP : light),
  };
}

export function TerminalPanel(props: IDockviewPanelProps<{ termId?: string }>) {
  const s = useActiveSession();
  const theme = useUi((st) => st.theme);
  const scheme = useUi((st) => st.scheme);
  const termFontSize = useUi((st) => st.termFontSize);
  const fonts = useUi((st) => st.fonts);
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"starting" | "live" | "reconnecting" | "exited" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [termId, setTermId] = useState<string | undefined>(props.params.termId);
  // A terminal binds to the session that is active when it first can (the
  // default layout opens one before any session exists), and stays bound.
  const [bound, setBound] = useState<string | null>(s?.id ?? null);
  useEffect(() => {
    if (!bound && s) setBound(s.id);
  }, [s?.id, bound]);
  const sessionAtMount = useRef<string | null>(null);

  // Create the pty (or reattach to an existing one) and wire the socket.
  useEffect(() => {
    const sid = bound;
    sessionAtMount.current = sid;
    if (!sid || !host.current) return;
    let disposed = false;
    const term = new Terminal({ cursorBlink: true, fontSize: termFontSize, fontFamily: css("--m-font-mono") || "monospace", theme: xtermTheme(isDark()), scrollback: 5000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    // Bundled fonts may finish loading after the terminal measured its cells.
    document.fonts?.ready.then(() => { if (!disposed) try { fit.fit(); } catch { /* ignore */ } });

    const connect = async () => {
      let id = termId;
      try {
        if (id) {
          const existing = await api.terminals(sid).then((r) => r.terminals.find((t) => t.id === id));
          if (!existing) id = undefined;
        }
        if (!id) {
          const { terminal } = await api.createTerminal(sid, { cols: term.cols, rows: term.rows });
          id = terminal.id;
          setTermId(id);
          props.api.updateParameters({ termId: id });
          props.api.setTitle(`Terminal · ${terminal.shell.split(/[\\/]/).pop()}`);
        }
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (disposed) return;
      // Input goes through whichever socket is current. If the socket drops
      // (server restart, sleep/wake, a proxy idling), reconnect with backoff
      // instead of silently discarding keystrokes, and say so in the debug log.
      let exited = false;
      let attempt = 0;
      let dropped = 0;
      const open = () => {
        if (disposed || exited) return;
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/terminal/${id}`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;
        ws.onopen = () => {
          diag(`terminal ${id} socket open${attempt ? ` (reconnect #${attempt}${dropped ? `, ${dropped} keystrokes were dropped while down` : ""})` : ""}`);
          attempt = 0;
          dropped = 0;
          setStatus("live");
          setError(null);
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          term.focus();
        };
        ws.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
          else {
            try {
              const m = JSON.parse(String(ev.data));
              if (m.type === "exit") { exited = true; setStatus("exited"); }
              if (m.type === "hello" && m.terminal?.shell) props.api.setTitle(`Terminal · ${String(m.terminal.shell).split(/[\\/]/).pop()}`);
            } catch {
              term.write(String(ev.data));
            }
          }
        };
        ws.onerror = () => diag(`terminal ${id} socket error`);
        ws.onclose = (ev) => {
          if (disposed || exited) return;
          diag(`terminal ${id} socket closed code=${ev.code} reason="${ev.reason}"`);
          if (ev.code === 4404) {
            setStatus("error");
            setError("This terminal no longer exists on the server (it restarted). Close the tab and open a new one.");
            return;
          }
          if (ev.code === 1000) {
            // the server closed it on purpose (session closed or terminal killed)
            exited = true;
            setStatus("exited");
            return;
          }
          setStatus("reconnecting");
          const delay = Math.min(8000, 400 * 2 ** attempt++);
          setTimeout(open, delay);
        };
      };
      open();
      const send = (data: Uint8Array) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
        else dropped += 1;
      };
      term.onData((d) => send(new TextEncoder().encode(d)));
      term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN && cols > 1 && rows > 0) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });
    };
    void connect();

    // Fit only when the host has a real size; fitting a hidden or collapsing
    // panel produces 0-column resizes that confuse the shell.
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width < 40 || r.height < 20) return;
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(host.current);
    const onVisible = props.api.onDidVisibilityChange((e) => {
      if (e.isVisible) setTimeout(() => { try { fit.fit(); term.focus(); } catch { /* ignore */ } }, 0);
    });
    const onActive = props.api.onDidActiveChange((e) => e.isActive && term.focus());

    return () => {
      disposed = true;
      ro.disconnect();
      onVisible.dispose();
      onActive.dispose();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound]);

  // Live theme + font changes.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.theme = xtermTheme(isDark());
    t.options.fontSize = termFontSize;
    t.options.fontFamily = css("--m-font-mono") || "monospace";
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [theme, scheme, termFontSize, fonts]);

  const kill = async () => {
    if (!sessionAtMount.current || !termId) return props.api.close();
    await api.killTerminal(sessionAtMount.current, termId).catch(() => {});
    props.api.close();
  };

  return (
    <div className="term">
      {!bound && <div className="empty" style={{ padding: 10 }}>Start a session; this terminal will open in its clone.</div>}
      <div className="term-bar">
        <span className="faint">
          your shell in <code>{s?.repoDir ?? ""}</code> · not the agent’s, not gated
        </span>
        <span className={`tag ${status === "live" ? "ok" : status === "error" ? "bad" : status === "reconnecting" ? "warn" : ""}`}>{status}</span>
        <button className="btn sm" onClick={() => store.setTermFontSize(termFontSize - 1)} title="smaller">A−</button>
        <button className="btn sm" onClick={() => store.setTermFontSize(termFontSize + 1)} title="larger">A+</button>
        <button className="btn sm" onClick={() => termRef.current?.clear()} title="clear scrollback">clear</button>
        <button className="btn sm" onClick={kill} title="kill the shell and close the tab">kill</button>
      </div>
      {error && <div className="tag bad" style={{ margin: "6px 8px", whiteSpace: "normal" }}>{error}</div>}
      <div className="term-host" ref={host} onMouseDown={() => termRef.current?.focus()} />
    </div>
  );
}

function isDark(): boolean {
  // The theme tokens set `color-scheme` on :root for whichever scheme is active.
  return getComputedStyle(document.documentElement).colorScheme.includes("dark");
}
