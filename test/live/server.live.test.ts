/**
 * End-to-end over HTTP + websocket with a real haiku session: what the
 * future UI will actually do. Create via REST (preflight on, against a
 * throwaway local repo), watch the socket for the guardrail approval,
 * deny it via REST, and see the turn arrive with structured state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import WebSocket from "ws";

import { createMendophyteServer } from "../../src/server/index.js";

const LIVE = process.env.MENDOPHYTE_LIVE === "1";
const MODEL = process.env.MENDOPHYTE_TEST_MODEL ?? "haiku";
const root = path.resolve(new URL(".", import.meta.url).pathname, "../..");

test("live: session over REST + websocket, guardrail denied through the API", { skip: !LIVE, timeout: 300_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-server-live-"));
  const repoDir = path.join(base, "repo");
  await mkdir(repoDir);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(path.join(repoDir, "README.md"), "# fixture\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  await writeFile(path.join(repoDir, "notes.txt"), "uncommitted\n");

  const server = await createMendophyteServer({ port: 0 });
  const log: string[] = [];
  try {
    const ws = new WebSocket(server.url.replace(/^http/, "ws") + "/ws");
    const inbox: any[] = [];
    const waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "session.event") log.push(`${m.event}: ${JSON.stringify(m.data).slice(0, 120)}`);
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].res(m);
      else inbox.push(m);
    });
    const next = (pred: (m: any) => boolean, ms = 240_000) =>
      new Promise<any>((res, rej) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        const t = setTimeout(() => rej(new Error(`timed out; last events:\n${log.slice(-15).join("\n")}`)), ms);
        waiters.push({ pred, res: (m) => (clearTimeout(t), res(m)) });
      });
    await new Promise<void>((r) => ws.once("open", () => r()));
    await next((m) => m.type === "snapshot");

    const created = await fetch(server.url + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoDir,
        artifactHome: path.join(base, "artifacts"),
        model: MODEL,
        maxTurns: 12,
        promptDir: path.join(root, "prompts"),
        kickoff: [
          "Mechanical tooling test; one or two sentences of prose.",
          "1. Run `git status --short` with Bash.",
          "2. Run `git commit -am \"test commit\"` with Bash. This message is my explicit go-ahead for that exact commit, so run it now.",
          "3. Report what happened. If a command was declined, say so and stop.",
          "Structured output: phase 0, phase_complete false, one your_turn_items entry of kind confirm_go_ahead.",
        ].join("\n"),
      }),
    });
    assert.equal(created.status, 201);
    const { session } = await created.json();

    const pending = await next((m) => m.type === "approval.pending" && m.approval.sessionId === session.id);
    assert.equal(pending.approval.match.ruleId, "git-commit");

    const listed = await (await fetch(server.url + "/api/approvals")).json();
    assert.equal(listed.approvals[0].id, pending.approval.id);

    const denied = await fetch(server.url + `/api/approvals/${pending.approval.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: false, reason: "test denies commits" }),
    });
    assert.equal(denied.status, 200);
    await next((m) => m.type === "approval.resolved" && m.approval.id === pending.approval.id);

    const turn = await next((m) => m.type === "session.event" && m.event === "turn" && m.sessionId === session.id);
    assert.equal(turn.data.subtype, "success");
    assert.ok(turn.data.state, `no state: ${turn.data.stateError}`);
    assert.equal(turn.data.state.phase, 0);

    const commits = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir }).toString().trim());
    assert.equal(commits, 1, "no commit should have landed");

    const detail = await (await fetch(server.url + `/api/sessions/${session.id}`)).json();
    assert.equal(detail.session.status, "running");
    assert.equal(detail.session.lastState.phase, 0);
    assert.ok(detail.session.sdkSessionId);

    assert.equal((await fetch(server.url + `/api/sessions/${session.id}/end`, { method: "POST" })).status, 202);
    await next((m) => m.type === "session.updated" && m.session.status === "ended", 60_000);
    ws.close();
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
