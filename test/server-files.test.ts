/**
 * File tree, file viewer and artifact endpoints, plus the artifact-home
 * watcher that pushes `artifacts` events over the socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
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

test("server: files, file viewer, artifact files and the artifact watcher", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-files-"));
  const repoDir = path.join(base, "repo");
  const artifactHome = path.join(base, "art");
  const outside = path.join(base, "secret.txt");
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await writeFile(outside, "not for you\n");
  await writeFile(path.join(repoDir, "README.md"), "# hi\n");
  await writeFile(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n// TODO x\n");
  await writeFile(path.join(repoDir, "src", "bin.dat"), Buffer.from([0, 1, 2, 3]));
  await symlink(outside, path.join(repoDir, "leak.txt"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "fix: init");
  await writeFile(path.join(repoDir, "untracked.txt"), "new\n");

  const server = await createMendophyteServer({ port: 0, factory: (c) => new FakeSession(c) });
  try {
    const api = async (p: string) => {
      const res = await fetch(server.url + "/api" + p);
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ws = new WebSocket(server.url.replace(/^http/, "ws") + "/ws");
    const frames: any[] = [];
    ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((r) => ws.once("open", () => r()));

    const created = await fetch(server.url + "/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoDir, artifactHome, preflight: false, noKickoff: true }) });
    const { session } = await created.json();
    const id = session.id;

    // listing without overlay
    const plain = await api(`/sessions/${id}/files`);
    assert.equal(plain.status, 200);
    const paths = plain.json.listing.files.map((f: any) => f.path).sort();
    assert.deepEqual(paths, ["README.md", "leak.txt", "src/a.ts", "src/bin.dat", "untracked.txt"]);
    assert.equal(plain.json.listing.fragilityWindow, null);
    assert.equal(plain.json.listing.files[0].heat, undefined);

    // with fragility overlay computed on demand and cached
    const heat = await api(`/sessions/${id}/files?fragility=1`);
    assert.ok(heat.json.listing.fragilityWindow);
    const a = heat.json.listing.files.find((f: any) => f.path === "src/a.ts");
    assert.equal(a.commits, 1);
    assert.equal(a.fixCommits, 1);
    assert.equal(a.markers, 1);
    assert.ok(a.heat > 0);
    const again = await api(`/sessions/${id}/files`);
    assert.ok(again.json.listing.fragilityWindow, "overlay cached for later requests");

    // file reads
    const ok = await api(`/sessions/${id}/file?path=src/a.ts`);
    assert.equal(ok.status, 200);
    assert.match(ok.json.file.content, /export const a/);
    assert.equal(ok.json.file.binary, false);
    const bin = await api(`/sessions/${id}/file?path=src/bin.dat`);
    assert.equal(bin.json.file.binary, true);
    assert.equal(bin.json.file.content, "");
    assert.equal((await api(`/sessions/${id}/file?path=../secret.txt`)).status, 400);
    assert.equal((await api(`/sessions/${id}/file?path=leak.txt`)).status, 400, "symlink out of the repo is refused");
    assert.equal((await api(`/sessions/${id}/file?path=nope.txt`)).status, 404);
    assert.equal((await api(`/sessions/${id}/file?path=src`)).status, 400);
    assert.equal((await api(`/sessions/${id}/file?path=`)).status, 400);

    // artifacts: write one and expect the watcher to push a listing
    const before = frames.filter((f) => f.type === "session.event" && f.event === "artifacts").length;
    await writeFile(path.join(artifactHome, "A-recon-notes.md"), "# Recon\n");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && frames.filter((f) => f.type === "session.event" && f.event === "artifacts").length === before) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const ev = frames.filter((f) => f.type === "session.event" && f.event === "artifacts").at(-1);
    assert.ok(ev, "artifacts event should arrive from the watcher");
    assert.ok(ev.data.entries.some((e: any) => e.name === "A-recon-notes.md"));

    const art = await api(`/sessions/${id}/artifacts/file?name=A-recon-notes.md`);
    assert.equal(art.status, 200);
    assert.equal(art.json.file.content, "# Recon\n");
    assert.equal((await api(`/sessions/${id}/artifacts/file?name=../repo/README.md`)).status, 400);

    ws.close();
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
