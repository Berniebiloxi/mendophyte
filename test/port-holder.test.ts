/**
 * Identifying and clearing whatever holds the port when it isn't answering
 * as Mendophyte (a stuck older instance, typically). Spawns a child that
 * listens without serving HTTP, with "mendophyte" in its argv so it counts
 * as ours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { findListener, killHolder, probeInstance } from "../src/server/probe.js";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

test("port holder: a silent listener is identified by pid and command, and cleared", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000)`, "mendophyte-holder-fixture"], { stdio: "ignore" });
  try {
    // wait until it is listening
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await findListener(port))) await new Promise((r) => setTimeout(r, 50));

    assert.equal(await probeInstance(port, 800), null, "raw TCP listener never answers HTTP");
    const holder = await findListener(port);
    assert.ok(holder, "listener should be found");
    assert.equal(holder!.pid, child.pid);
    assert.match(holder!.command ?? "", /mendophyte-holder-fixture/);
    assert.equal(holder!.looksLikeMendophyte, true);

    const cleared = await killHolder(holder!, port);
    assert.equal(cleared, true);
    assert.equal(await findListener(port), null);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
});

test("port holder: nothing on a free port", async () => {
  const port = await freePort();
  assert.equal(await findListener(port), null);
});
