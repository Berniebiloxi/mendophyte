import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";

/**
 * The user's own shells inside the target repository, one pty each,
 * bridged to xterm in the browser. This is deliberately NOT the agent's
 * session: nothing typed here is gated by the guardrails or seen by the
 * agent. It is the "go look yourself" surface the meta-prompt's handoffs
 * keep asking for.
 *
 * Output is kept in a scrollback ring so a reload or reconnect repaints
 * the screen instead of starting blank.
 */

const require = createRequire(import.meta.url);
type NodePty = typeof import("node-pty");
type IPty = import("node-pty").IPty;

let ptyModule: NodePty | null | undefined;
/** node-pty is a native module; if it failed to build, the panel says so instead of the server crashing at import. */
export function loadPty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = require("node-pty") as NodePty;
    ensureSpawnHelperExecutable();
  } catch (e) {
    ptyModule = null;
    lastPtyError = e instanceof Error ? e.message : String(e);
  }
  return ptyModule;
}

/**
 * On macOS node-pty forks through a small `spawn-helper` binary shipped in
 * its prebuilds. npm sometimes installs it without the execute bit, and
 * the symptom is an opaque "posix_spawnp failed". Restore the bit once.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform !== "darwin") return;
  try {
    const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    const st = statSync(helper);
    if ((st.mode & 0o111) === 0) chmodSync(helper, st.mode | 0o755);
  } catch {
    /* no prebuilt helper (built from source) or not writable; spawning will report if it matters */
  }
}
let lastPtyError: string | null = null;
export function ptyLoadError(): string | null {
  loadPty();
  return lastPtyError;
}

export interface TerminalInfo {
  id: string;
  sessionId: string;
  cwd: string;
  shell: string;
  pid: number;
  cols: number;
  rows: number;
  createdAt: string;
  exited: { exitCode: number; signal?: number } | null;
}

interface Term extends TerminalInfo {
  pty: IPty;
  scrollback: Buffer[];
  scrollbackBytes: number;
  clients: Set<WebSocket>;
}

export const SCROLLBACK_BYTES = 256 * 1024;
export const MAX_TERMINALS_PER_SESSION = 8;

export function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC && /powershell|pwsh/i.test(process.env.SHELL ?? "") ? process.env.SHELL! : "powershell.exe", args: ["-NoLogo"] };
  }
  const sh = process.env.SHELL || "/bin/bash";
  // login shell so the user's PATH and prompt match their normal terminal
  return { file: sh, args: ["-l"] };
}

export class TerminalManager extends EventEmitter {
  private terms = new Map<string, Term>();

  list(sessionId?: string): TerminalInfo[] {
    return [...this.terms.values()].filter((t) => !sessionId || t.sessionId === sessionId).map(strip);
  }

  get(id: string): TerminalInfo | undefined {
    const t = this.terms.get(id);
    return t ? strip(t) : undefined;
  }

  create(opts: { sessionId: string; cwd: string; cols?: number; rows?: number; env?: NodeJS.ProcessEnv }): TerminalInfo {
    const pty = loadPty();
    if (!pty) throw new TerminalError(`node-pty is not available: ${lastPtyError ?? "unknown error"}`);
    if (this.list(opts.sessionId).filter((t) => !t.exited).length >= MAX_TERMINALS_PER_SESSION) {
      throw new TerminalError(`at most ${MAX_TERMINALS_PER_SESSION} terminals per session`);
    }
    const { file, args } = defaultShell();
    const cols = opts.cols ?? 100;
    const rows = opts.rows ?? 30;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...(opts.env ?? {}) })) if (v !== undefined) env[k] = v;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.MENDOPHYTE = "1";
    // A shell started from inside a Claude Code session inherits its guard;
    // this is the user's own shell, so drop the marker.
    delete env.CLAUDECODE;

    let proc: IPty;
    try {
      proc = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd: opts.cwd, env, useConpty: process.platform === "win32" ? true : undefined });
    } catch (e) {
      throw new TerminalError(`could not start ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const term: Term = {
      id: randomUUID(),
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      shell: file,
      pid: proc.pid,
      cols,
      rows,
      createdAt: new Date().toISOString(),
      exited: null,
      pty: proc,
      scrollback: [],
      scrollbackBytes: 0,
      clients: new Set(),
    };
    this.terms.set(term.id, term);

    proc.onData((data) => {
      const buf = Buffer.from(data, "utf8");
      term.scrollback.push(buf);
      term.scrollbackBytes += buf.length;
      while (term.scrollbackBytes > SCROLLBACK_BYTES && term.scrollback.length > 1) term.scrollbackBytes -= term.scrollback.shift()!.length;
      for (const c of term.clients) if (c.readyState === c.OPEN) c.send(buf, { binary: true });
    });
    proc.onExit((e) => {
      term.exited = e;
      const note = Buffer.from(`\r\n\x1b[2m[shell exited with code ${e.exitCode}]\x1b[0m\r\n`);
      term.scrollback.push(note);
      for (const c of term.clients) {
        if (c.readyState === c.OPEN) {
          c.send(note, { binary: true });
          c.send(JSON.stringify({ type: "exit", code: e.exitCode, signal: e.signal }));
        }
      }
      this.emit("exit", strip(term));
    });

    this.emit("created", strip(term));
    return strip(term);
  }

  /** Binds a websocket: replays scrollback, then streams both ways until either side closes. */
  attach(id: string, ws: WebSocket): void {
    const term = this.terms.get(id);
    if (!term) {
      ws.close(4404, "no such terminal");
      return;
    }
    term.clients.add(ws);
    ws.send(JSON.stringify({ type: "hello", terminal: strip(term) }));
    if (term.scrollback.length) ws.send(Buffer.concat(term.scrollback), { binary: true });
    if (term.exited) ws.send(JSON.stringify({ type: "exit", code: term.exited.exitCode, signal: term.exited.signal }));

    ws.on("message", (raw, isBinary) => {
      if (term.exited) return;
      if (isBinary) {
        term.pty.write(Buffer.isBuffer(raw) ? raw.toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8"));
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        // text frames that aren't JSON are treated as input too
        term.pty.write(String(raw));
        return;
      }
      if (msg?.type === "resize") {
        const cols = Math.max(2, Math.min(500, Number(msg.cols) | 0));
        const rows = Math.max(1, Math.min(200, Number(msg.rows) | 0));
        if (cols && rows) {
          term.cols = cols;
          term.rows = rows;
          try {
            term.pty.resize(cols, rows);
          } catch {
            /* exited between check and resize */
          }
        }
      } else if (msg?.type === "input" && typeof msg.data === "string") {
        term.pty.write(msg.data);
      }
    });
    ws.on("close", () => term.clients.delete(ws));
  }

  kill(id: string): boolean {
    const term = this.terms.get(id);
    if (!term) return false;
    for (const c of term.clients) c.close(1000, "terminal closed");
    if (!term.exited) {
      try {
        term.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.terms.delete(id);
    this.emit("closed", strip(term));
    return true;
  }

  killForSession(sessionId: string): void {
    for (const t of [...this.terms.values()]) if (t.sessionId === sessionId) this.kill(t.id);
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

function strip(t: Term | TerminalInfo): TerminalInfo {
  const { id, sessionId, cwd, shell, pid, cols, rows, createdAt, exited } = t;
  return { id, sessionId, cwd, shell, pid, cols, rows, createdAt, exited };
}

export class TerminalError extends Error {}

export const hostInfo = { platform: process.platform, shell: defaultShell().file, user: os.userInfo().username };
