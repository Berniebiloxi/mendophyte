/**
 * Submission endpoints and the forge poller through the server with a fake
 * session: get computes on first call, refresh re-emits, polling streams
 * `submission` events on a timer and stops on request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import WebSocket from "ws";

import { createMendophyteServer } from "../src/server/index.js";
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

test("server: submission get/refresh/poll", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-server-sub-"));
  const repoDir = path.join(base, "repo");
  await mkdir(repoDir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(path.join(repoDir, "README.md"), "# fx\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const server = await createMendophyteServer({ port: 0, factory: (c) => new FakeSession(c) });
  try {
    const api = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(server.url + "/api" + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ws = new WebSocket(server.url.replace(/^http/, "ws") + "/ws");
    const frames: any[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((r) => ws.once("open", () => r()));
    const subEvents = () => frames.filter((f) => f.type === "session.event" && f.event === "submission");

    const created = await api("POST", "/sessions", { repoDir, artifactHome: path.join(base, "art"), preflight: false, noKickoff: true });
    const id = created.json.session.id;

    const first = await api("GET", `/sessions/${id}/submission`);
    assert.equal(first.status, 200);
    assert.equal(first.json.report.branch, "main");
    assert.equal(first.json.report.prObserved, false);
    assert.match(first.json.report.prReason, /no origin remote/);
    assert.equal(first.json.pollingSec, null);
    assert.match(first.json.facts, /Submission status/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(subEvents().length, 1, "first computation is streamed");

    const cached = await api("GET", `/sessions/${id}/submission`);
    assert.equal(cached.json.report.ranAt, first.json.report.ranAt, "served from cache without recomputing");

    const refreshed = await api("POST", `/sessions/${id}/submission/refresh`, { fetch: false });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.json.report.ranAt, first.json.report.ranAt);

    assert.equal((await api("POST", `/sessions/${id}/submission/poll`, { intervalSec: "soon" })).status, 400);
    const poll = await api("POST", `/sessions/${id}/submission/poll`, { intervalSec: 1 });
    assert.equal(poll.json.pollingSec, 15, "clamped to the 15s floor");
    const before = subEvents().length;
    // The first poll spawns several git processes; give slow runners (Windows) time, but not a fixed sleep.
    const deadline = Date.now() + 15_000;
    while (subEvents().length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(subEvents().length > before, "starting polling refreshes immediately");
    const stop = await api("POST", `/sessions/${id}/submission/poll`, { intervalSec: null });
    assert.equal(stop.json.pollingSec, null);
    assert.equal((await api("GET", `/sessions/${id}/submission`)).json.pollingSec, null);

    ws.close();
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
