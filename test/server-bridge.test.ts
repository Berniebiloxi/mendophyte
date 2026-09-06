/**
 * Transport test for the server bridge with a fake session: no model, no
 * network. Proves the REST commands and websocket events line up with
 * what a UI needs: create -> events stream -> approval pending -> resolve
 * over REST and over the socket -> state on the summary -> replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";

import { createMendophyteServer } from "../src/server/index.js";
import type { SessionLike } from "../src/server/session-manager.js";
import { matchGuardrail, type SessionConfig } from "../src/orchestrator/index.js";

/** A scriptable stand-in for MendophyteSession that routes Bash through the real broker. */
class FakeSession extends EventEmitter implements SessionLike {
  sessionId: string | null = null;
  lastState: any = null;
  sent: string[] = [];
  ended = false;
  closed = false;
  constructor(public config: SessionConfig) {
    super();
  }
  async start() {
    setTimeout(() => {
      this.sessionId = "sdk-123";
      this.emit("init", { sessionId: "sdk-123", model: "fake", permissionMode: "default", tools: ["Bash"] });
    }, 5);
  }
  send(text: string) {
    this.sent.push(text);
  }
  async interrupt() {}
  end() {
    this.ended = true;
    this.emit("end");
  }
  close() {
    this.closed = true;
  }
  /** Simulate the agent trying a Bash command: guardrail -> broker -> tool_use or deny. */
  async tryBash(command: string) {
    const match = matchGuardrail(command);
    if (!match) {
      this.emit("tool_use", { name: "Bash", input: { command }, id: "t1" });
      return { ran: true };
    }
    const d = await this.config.approvals.request({ toolName: "Bash", input: { command }, command, match, cwd: this.config.repoDir });
    if (d.approved) this.emit("tool_use", { name: "Bash", input: { command }, id: "t2" });
    return { ran: d.approved };
  }
  finishTurn(state: any) {
    this.lastState = state;
    this.emit("state", state);
    this.emit("turn", { result: { type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.01, session_id: "sdk-123" }, state });
  }
}

function connect(url: string): Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
    const queue: any[] = [];
    const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].res(m);
      else queue.push(m);
    });
    const next = (pred: (m: any) => boolean) =>
      new Promise<any>((res, rej) => {
        const i = queue.findIndex(pred);
        if (i >= 0) return res(queue.splice(i, 1)[0]);
        const t = setTimeout(() => rej(new Error("timed out waiting for ws message")), 5000);
        waiters.push({ pred, res: (m) => (clearTimeout(t), res(m)) });
      });
    ws.once("open", () => resolve({ ws, next }));
    ws.once("error", reject);
  });
}

test("server bridge: REST + websocket round trip with a fake session", async () => {
  const fakes: FakeSession[] = [];
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mendophyte-bridge-"));
  const server = await createMendophyteServer({ port: 0, factory: (c) => { const f = new FakeSession(c); fakes.push(f); return f; } });
  try {
    const api = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(server.url + "/api" + p, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    // Client connects first, so it sees the whole lifecycle.
    const { ws, next } = await connect(server.url);
    const snap = await next((m) => m.type === "snapshot");
    assert.deepEqual(snap.sessions, []);

    // Input validation: the repo path must exist and be a git repository; the model is normalised.
    const missing = await api("POST", "/sessions", { repoDir: path.join(tmp, "nope"), preflight: false });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /does not exist/);
    const notGit = await api("POST", "/sessions", { repoDir: tmp, preflight: false });
    assert.equal(notGit.status, 400);
    assert.match(notGit.json.error, /not a git repository/);
    assert.equal(fakes.length, 0, "no session is created for invalid input");

    // A git repo reached through a symlinked path (macOS temp dirs work this way) is accepted;
    // a subdirectory of a repo is refused with a pointer to the root.
    if (process.platform !== "win32") {
      const realRepo = path.join(tmp, "realrepo");
      await mkdir(path.join(realRepo, "sub"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: realRepo });
      const link = path.join(tmp, "linkrepo");
      await symlink(realRepo, link);
      const viaLink = await api("POST", "/sessions", { repoDir: link, artifactHome: path.join(tmp, "art2"), preflight: false, noKickoff: true });
      assert.equal(viaLink.status, 201, JSON.stringify(viaLink.json));
      const sub = await api("POST", "/sessions", { repoDir: path.join(realRepo, "sub"), preflight: false, noKickoff: true });
      assert.equal(sub.status, 400);
      assert.match(sub.json.error, /use the repository root/);
      await api("DELETE", `/sessions/${viaLink.json.session.id}`);
      fakes.length = 0;
    }

    // Create: preflight off, scripted kickoff, non-git allowed for the fake.
    const created = await api("POST", "/sessions", { repoDir: tmp, artifactHome: path.join(tmp, "art"), preflight: false, kickoff: "hello agent", allowNonGit: true, model: " /Sonnet " });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.session.id as string;
    assert.equal(fakes.length, 1);
    assert.deepEqual(fakes[0].sent, ["hello agent"]);
    assert.equal(fakes[0].config.artifactHome, path.join(tmp, "art"));
    assert.equal(fakes[0].config.model, "sonnet", "slash-command style model input is normalised");
    assert.equal(created.json.session.model, "sonnet");

    await next((m) => m.type === "session.created" && m.session.id === id);
    const init = await next((m) => m.type === "session.event" && m.event === "init" && m.sessionId === id);
    assert.equal(init.sessionId, id);
    const running = await next((m) => m.type === "session.updated" && m.session.status === "running" && m.session.id === id);
    assert.equal(running.session.sdkSessionId, "sdk-123");

    // Plain command: no approval, just a tool_use event.
    await fakes[0].tryBash("git status");
    const tu = await next((m) => m.type === "session.event" && m.event === "tool_use" && m.sessionId === id);
    assert.equal(tu.data.input.command, "git status");

    // Guardrail command: pending approval on the socket and via REST; deny via REST.
    const attempt = fakes[0].tryBash("git push origin main");
    const pending = await next((m) => m.type === "approval.pending");
    assert.equal(pending.approval.sessionId, id);
    assert.equal(pending.approval.match.ruleId, "git-push");
    const listed = await api("GET", "/approvals");
    assert.equal(listed.json.approvals.length, 1);
    const summary1 = await api("GET", `/sessions/${id}`);
    assert.equal(summary1.json.session.pendingApprovals, 1);

    const denied = await api("POST", `/approvals/${pending.approval.id}`, { approved: false, reason: "not yet" });
    assert.equal(denied.status, 200);
    const resolved = await next((m) => m.type === "approval.resolved");
    assert.equal(resolved.decision.approved, false);
    assert.equal(resolved.decision.reason, "not yet");
    assert.deepEqual(await attempt, { ran: false });
    assert.equal((await api("GET", "/approvals")).json.approvals.length, 0);

    // Second guardrail command approved over the socket itself.
    const attempt2 = fakes[0].tryBash("git commit -m ok");
    const pending2 = await next((m) => m.type === "approval.pending");
    ws.send(JSON.stringify({ type: "approval.resolve", id: pending2.approval.id, approved: true }));
    await next((m) => m.type === "approval.resolved" && m.approval.id === pending2.approval.id);
    assert.deepEqual(await attempt2, { ran: true });

    // Unknown approval id over the socket -> error frame, nothing thrown.
    ws.send(JSON.stringify({ type: "approval.resolve", id: "nope", approved: true }));
    const err = await next((m) => m.type === "error");
    assert.match(err.message, /no pending approval/);

    // Turn completes with state: summary reflects it, event carries it.
    const state = { phase: 0, phase_complete: false, your_turn_items: [{ id: "q1", kind: "answer_question", prompt: "Experience?", blocks: "none" }] };
    fakes[0].finishTurn(state);
    const turn = await next((m) => m.type === "session.event" && m.event === "turn" && m.sessionId === id);
    assert.equal(turn.data.state.phase, 0);
    const s2 = await api("GET", `/sessions/${id}`);
    assert.equal(s2.json.session.lastState.your_turn_items[0].id, "q1");

    // Send a message via REST and via the socket.
    assert.equal((await api("POST", `/sessions/${id}/messages`, { text: "Experienced" })).status, 202);
    ws.send(JSON.stringify({ type: "session.send", sessionId: id, text: "option 3" }));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fakes[0].sent, ["hello agent", "Experienced", "option 3"]);
    assert.equal((await api("POST", `/sessions/${id}/messages`, { text: "" })).status, 400);

    // Replay from the buffer, over REST and over the socket.
    const evs = await api("GET", `/sessions/${id}/events?after=0`);
    assert.ok(evs.json.events.some((e: any) => e.event === "init"));
    assert.ok(evs.json.events.some((e: any) => e.event === "turn"));
    const lastSeq = evs.json.events.at(-1).seq;
    ws.send(JSON.stringify({ type: "replay", sessionId: id, afterSeq: lastSeq - 1 }));
    const replayed = await next((m) => m.type === "session.event" && m.seq === lastSeq);
    assert.equal(replayed.sessionId, id);

    // A second client gets the live picture in its snapshot.
    const c2 = await connect(server.url);
    const snap2 = await c2.next((m) => m.type === "snapshot");
    assert.equal(snap2.sessions[0].id, id);
    assert.equal(snap2.sessions[0].status, "running");
    c2.ws.close();

    // End, then remove.
    assert.equal((await api("POST", `/sessions/${id}/end`)).status, 202);
    await next((m) => m.type === "session.updated" && m.session.status === "ended");
    assert.equal((await api("DELETE", `/sessions/${id}`)).status, 200);
    await next((m) => m.type === "session.removed" && m.id === id);
    assert.equal(fakes[0].closed, true);
    assert.equal((await api("GET", `/sessions/${id}`)).status, 404);
    assert.equal((await api("POST", `/sessions/${id}/messages`, { text: "x" })).status, 404);

    ws.close();
  } finally {
    await server.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("server bridge: validation and health", async () => {
  const server = await createMendophyteServer({ port: 0, factory: (c) => new FakeSession(c) });
  try {
    const bad = await fetch(server.url + "/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 400);
    const health = await (await fetch(server.url + "/api/health")).json();
    assert.equal(health.status, "ok");
    assert.equal(health.sessions, 0);
    const page = await fetch(server.url + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Mendophyte/);
  } finally {
    await server.close();
  }
});
