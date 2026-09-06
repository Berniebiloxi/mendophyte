import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DiagnosticLog, brief, redact } from "../src/server/diag.js";
import { createMendophyteServer } from "../src/server/index.js";

test("diag: redacts tokens and keeps everything else", () => {
  assert.equal(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123 here"), "token [redacted] here");
  assert.equal(redact("ANTHROPIC sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "ANTHROPIC [redacted]");
  assert.equal(redact("git commit -m 'fix'"), "git commit -m 'fix'");
  assert.match(brief({ a: "x".repeat(1000) }, 50), /… \(\+\d+ chars\)$/);
});

test("diag: the log file is markdown, the endpoints serve and accept entries, secrets never land", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mendo-diag-"));
  const diag = new DiagnosticLog({ dir, name: "test" });
  const server = await createMendophyteServer({ port: 0, diag });
  try {
    const base = server.url;
    // a request is logged (but not the diag endpoints themselves)
    await fetch(`${base}/api/sessions`);
    const post = await fetch(`${base}/api/diag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: [{ at: "2026-09-06T10:00:00.000Z", source: "ui", text: 'click button "Send" in Conversation' }, { source: "error", text: "boom ghp_abcdefghijklmnopqrstuvwxyz0123" }, { source: "bogus", text: "x" }] }),
    });
    assert.equal((await post.json()).count, 3);
    const get = await (await fetch(`${base}/api/diag?tail=100`)).json();
    assert.equal(get.path, diag.path);
    assert.ok(get.size > 0);
    assert.match(get.tail, /\| http \| GET \/api\/sessions → 200/);
    assert.match(get.tail, /\| 10:00:00.000 \| ui \| click button "Send" in Conversation \|/);
    assert.match(get.tail, /\| error \| boom \[redacted\] \|/);
    assert.doesNotMatch(get.tail, /ghp_/);
    assert.doesNotMatch(get.tail, /\/api\/diag/, "the log does not log itself");
    // pause: nothing is written; resume: writing continues, with markers either side
    assert.equal((await (await fetch(`${base}/api/diag/enabled`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).json()).enabled, false);
    await fetch(`${base}/api/sessions`);
    assert.equal((await (await fetch(`${base}/api/diag?tail=50`)).json()).enabled, false);
    assert.equal((await (await fetch(`${base}/api/diag/enabled`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) })).json()).enabled, true);
    const afterPause = (await (await fetch(`${base}/api/diag?tail=50`)).json()).tail as string;
    assert.match(afterPause, /log collection paused by the user/);
    assert.match(afterPause, /log collection resumed by the user/);
    assert.equal((afterPause.match(/GET \/api\/sessions → 200/g) ?? []).length, 1, "the request made while paused was not logged");
    const dl = await fetch(`${base}/api/diag/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-type") ?? "", /markdown/);
    const file = await readFile(diag.path, "utf8");
    assert.match(file, /^# Mendophyte debug log/);
    assert.match(file, /\| time \| src \| what \|/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
