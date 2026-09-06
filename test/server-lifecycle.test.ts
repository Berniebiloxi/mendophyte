/**
 * Instance discovery and shutdown: what the CLI's --replace / --stop rely on,
 * and that close() doesn't hang on a client holding a keep-alive connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { createMendophyteServer } from "../src/server/index.js";
import { probeInstance, requestShutdown } from "../src/server/probe.js";
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

test("lifecycle: probe recognises a Mendophyte instance, shutdown endpoint triggers the callback, close survives keep-alive clients", { timeout: 30_000 }, async () => {
  let shutdownRequested = 0;
  const server = await createMendophyteServer({ port: 0, factory: (c) => new FakeSession(c), onShutdown: () => shutdownRequested++ });

  const found = await probeInstance(server.port);
  assert.ok(found && found !== "other");
  assert.equal(found.pid, process.pid);
  assert.ok(found.startedAt);
  assert.equal(found.sessions, 0);

  // A plain HTTP server on another port is "other"; a closed port is null.
  const other = http.createServer((_req, res) => res.end("hi"));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  const otherPort = (other.address() as any).port;
  assert.equal(await probeInstance(otherPort), "other");
  other.close();
  assert.equal(await probeInstance(1, 500), null);

  // Keep-alive client holds a connection open; close() must not wait on it.
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    http.get(`${server.url}/api/health`, { agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });

  const res = await fetch(`${server.url}/api/shutdown`, { method: "POST" });
  assert.equal((await res.json()).ok, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(shutdownRequested, 1, "POST /api/shutdown invokes onShutdown");

  const t0 = Date.now();
  await server.close();
  assert.ok(Date.now() - t0 < 5000, `close() took ${Date.now() - t0}ms with a keep-alive client attached`);
  agent.destroy();
  assert.equal(await probeInstance(server.port, 500), null, "port released after close");
});

test("lifecycle: requestShutdown resolves true once the instance stops answering", { timeout: 30_000 }, async () => {
  let handle: Awaited<ReturnType<typeof createMendophyteServer>> | null = null;
  handle = await createMendophyteServer({ port: 0, factory: (c) => new FakeSession(c), onShutdown: () => void handle?.close() });
  const ok = await requestShutdown(handle.port, 8000);
  assert.equal(ok, true);
});
