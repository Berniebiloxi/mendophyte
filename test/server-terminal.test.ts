/**
 * The pty bridge: create a terminal for a session, stream through the
 * websocket, resize, replay scrollback on a second connection, kill.
 * Uses the real node-pty and the user's shell (skips if pty can't load).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import WebSocket from "ws";

import { createMendophyteServer } from "../src/server/index.js";
import { loadPty } from "../src/server/terminals.js";
import type { SessionLike } from "../src/server/session-manager.js";
import type { SessionConfig } from "../src/orchestrator/index.js";

class FakeSession extends EventEmitter implements SessionLike {
  sessionId: string | null = null;
  lastState: any = null;
  constructor(public config: SessionConfig) {
    super();
  }
  async start() {}
  send() {}
  async interrupt() {}
  end() {
    this.emit("end");
  }
  close() {}
}

function openTerm(url: string, id: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + `/ws/terminal/${id}`);
  ws.binaryType = "nodebuffer";
  let out = "";
  const ctrl: any[] = [];
  ws.on("message", (raw, isBinary) => {
    if (isBinary) out += (raw as Buffer).toString("utf8");
    else ctrl.push(JSON.parse(String(raw)));
  });
  const until = (pred: () => boolean, ms = 10_000) =>
    new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const tick = () => (pred() ? res() : Date.now() - t0 > ms ? rej(new Error(`timeout; output so far:\n${out.slice(-500)}`)) : setTimeout(tick, 30));
      tick();
    });
  return { ws, get out() { return out; }, ctrl, until, open: new Promise<void>((r) => ws.once("open", () => r())) };
}

test("server: terminal create, io, resize, scrollback replay, kill", { skip: !loadPty() || process.platform === "win32", timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-term-"));
  const server = await createMendophyteServer({ port: 0, factory: (c) => new FakeSession(c) });
  try {
    const api = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(server.url + "/api" + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const host = await api("GET", "/terminals/host");
    assert.equal(host.json.ptyError, null);

    const created = await api("POST", "/sessions", { repoDir: base, preflight: false, noKickoff: true, artifactHome: path.join(base, "art") });
    const sid = created.json.session.id;

    assert.equal((await api("GET", `/sessions/${sid}/terminals`)).json.terminals.length, 0);
    const t = await api("POST", `/sessions/${sid}/terminals`, { cols: 80, rows: 24 });
    assert.equal(t.status, 201, JSON.stringify(t.json));
    const tid = t.json.terminal.id as string;
    assert.equal(t.json.terminal.cwd, base);
    assert.ok(t.json.terminal.pid > 0);

    // first client: hello, then run a command
    const a = openTerm(server.url, tid);
    await a.open;
    await a.until(() => a.ctrl.some((c) => c.type === "hello"));
    // Use a command whose output can't be confused with the echoed input.
    a.ws.send(Buffer.from("printf 'pty-%s\\n' marker; pwd; tput cols\r"));
    await a.until(() => /pty-marker/.test(a.out) && a.out.includes(base));
    a.ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
    await new Promise((r) => setTimeout(r, 200));
    a.ws.send(Buffer.from("tput cols\r"));
    await a.until(() => /\b132\b/.test(a.out.slice(-200)));
    assert.equal((await api("GET", `/sessions/${sid}/terminals`)).json.terminals[0].cols, 132);

    // second client sees the scrollback replayed
    const b = openTerm(server.url, tid);
    await b.open;
    await b.until(() => /pty-marker/.test(b.out));
    assert.ok(b.ctrl.some((c) => c.type === "hello"));

    // unknown terminal id is refused with 4404
    const bad = new WebSocket(server.url.replace(/^http/, "ws") + "/ws/terminal/nope");
    const code = await new Promise<number>((r) => bad.on("close", (c) => r(c)));
    assert.equal(code, 4404);

    // exit the shell: exit frame arrives, terminal marked exited
    a.ws.send(Buffer.from("exit\r"));
    await a.until(() => a.ctrl.some((c) => c.type === "exit"));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok((await api("GET", `/sessions/${sid}/terminals`)).json.terminals[0].exited);

    // kill removes it; removing the session removes any remaining terminals
    assert.equal((await api("DELETE", `/sessions/${sid}/terminals/${tid}`)).status, 200);
    assert.equal((await api("GET", `/sessions/${sid}/terminals`)).json.terminals.length, 0);
    const t2 = await api("POST", `/sessions/${sid}/terminals`, {});
    assert.equal(t2.status, 201);
    await api("DELETE", `/sessions/${sid}`);
    assert.equal(server.terminals.list().length, 0);

    a.ws.close();
    b.ws.close();
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
