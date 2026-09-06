/**
 * Verification and diff endpoints through the server with a fake session:
 * the UI's "re-run checks" button and diff panel, and the shared history
 * that the agent's own tool calls also land in.
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

test("server: verification detect/run and diff endpoints", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-server-verify-"));
  const repoDir = path.join(base, "repo");
  await mkdir(repoDir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "fx", scripts: { test: `${node} test.js`, lint: `${node} -e "process.exit(2)"` } }));
  await writeFile(path.join(repoDir, "test.js"), "console.log('ok');\n");
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

    const created = await api("POST", "/sessions", { repoDir, artifactHome: path.join(base, "art"), preflight: false, noKickoff: true });
    assert.equal(created.status, 201);
    const id = created.json.session.id;

    // standalone detect
    const det = await api("POST", "/verification/detect", { repoDir });
    assert.equal(det.status, 200);
    assert.deepEqual(det.json.defaultSet.map((c: any) => c.id).sort(), ["npm:lint", "npm:test"]);

    // nothing to run -> 400
    assert.equal((await api("POST", `/sessions/${id}/verification`, {})).status, 400);

    // run detected set via the session endpoint
    const run = await api("POST", `/sessions/${id}/verification`, { useDetected: true, timeoutMinutes: 1 });
    assert.equal(run.status, 200, JSON.stringify(run.json));
    const by = Object.fromEntries(run.json.run.results.map((r: any) => [r.id, r]));
    assert.equal(by["npm:test"].status, "passed");
    assert.equal(by["npm:lint"].status, "failed");
    assert.equal(by["npm:lint"].exitCode, 2);
    assert.equal(run.json.run.allPassed, false);
    assert.match(run.json.facts, /PASS `npm:test`/);
    assert.ok(by["npm:test"].logPath.startsWith(path.join(base, "art", "logs")));

    // explicit checks, including a refused guardrail command
    const explicit = await api("POST", `/sessions/${id}/verification`, { checks: [{ id: "echo", command: `${node} -e "console.log(1)"` }, { command: "git push --force" }] });
    assert.equal(explicit.status, 200);
    assert.equal(explicit.json.run.results[0].status, "passed");
    assert.equal(explicit.json.run.results[1].status, "refused");

    // history has both runs, newest first; events streamed
    const hist = await api("GET", `/sessions/${id}/verification`);
    assert.equal(hist.json.runs.length, 2);
    assert.equal(hist.json.runs[0].id, explicit.json.run.id);
    assert.ok(hist.json.detected, "detection recorded on the session");
    await new Promise((r) => setTimeout(r, 30));
    const evs = frames.filter((f) => f.type === "session.event").map((f) => f.event);
    assert.ok(evs.includes("verification_detected"));
    assert.ok(evs.includes("verification_progress"));
    assert.equal(evs.filter((e) => e === "verification").length, 2);

    // diff endpoint
    await writeFile(path.join(repoDir, "test.js"), "console.log('changed');\n");
    const diff = await api("GET", `/sessions/${id}/diff`);
    assert.equal(diff.status, 200);
    assert.equal(diff.json.diff.filesChanged, 1);
    assert.match(diff.json.diff.patch, /\+console\.log\('changed'\)/);
    assert.deepEqual(diff.json.diff.status, [{ code: " M", path: "test.js" }]);

    const standalone = await api("POST", "/diff", { repoDir });
    assert.equal(standalone.json.diff.filesChanged, 1);
    assert.equal((await api("GET", `/sessions/nope/diff`)).status, 404);

    ws.close();
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
