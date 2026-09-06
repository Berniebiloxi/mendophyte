import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { apiRoutes } from "./routes.js";
import { SessionManager, type SessionFactory } from "./session-manager.js";
import { TerminalManager } from "./terminals.js";
import { attachWebSockets } from "./ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  url: string;
  port: number;
  http: HttpServer;
  manager: SessionManager;
  terminals: TerminalManager;
  close(): Promise<void>;
}

/**
 * Builds the local Mendophyte server: the built web app, the REST API under
 * /api, the event stream at /ws and pty bridges at /ws/terminal/:id.
 * `port: 0` picks a free port (tests). `factory` swaps the real Agent SDK
 * session for a fake so the transport can be tested without a model.
 */
export async function createMendophyteServer(opts: { port: number; host?: string; factory?: SessionFactory }): Promise<ServerHandle> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // src/server/index.ts -> dist/server/index.js at runtime, so this
  // walks up two levels to the package root, then into public/.
  const publicDir = path.resolve(__dirname, "../../public");
  app.use(express.static(publicDir));

  const manager = new SessionManager({ factory: opts.factory });
  const terminals = new TerminalManager();
  manager.on("session.removed", (id) => terminals.killForSession(id));
  app.use("/api", apiRoutes(manager, terminals));

  const http = createServer(app);
  const { hub, term } = attachWebSockets(http, manager, terminals);

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    http.once("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "EADDRINUSE" ? new Error(`Port ${opts.port} is already in use.`) : err);
    });
    http.listen(opts.port, host, () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    url: `http://localhost:${port}`,
    port,
    http,
    manager,
    terminals,
    close: async () => {
      terminals.killAll();
      manager.closeAll();
      for (const c of hub.clients) c.terminate();
      for (const c of term.clients) c.terminate();
      await new Promise<void>((r) => hub.close(() => r()));
      await new Promise<void>((r) => term.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

/** Kept for the CLI: starts the server and resolves to its URL. */
export async function startServer(port: number): Promise<string> {
  let factory: SessionFactory | undefined;
  if (process.env.MENDOPHYTE_FAKE_SESSION === "1") {
    const { FakeSession } = await import("./fake-session.js");
    factory = (c) => new FakeSession(c);
    console.warn("MENDOPHYTE_FAKE_SESSION=1: sessions are scripted fakes, no agent runs.");
  }
  const handle = await createMendophyteServer({ port, factory });
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return handle.url;
}
