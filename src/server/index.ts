import express from "express";
import { createServer, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { apiRoutes } from "./routes.js";
import { SessionManager, type SessionFactory } from "./session-manager.js";
import { TerminalManager } from "./terminals.js";
import { attachWebSockets } from "./ws.js";
import { DiagnosticLog, NULL_LOG, brief, type DiagEntry, type DiagSource } from "./diag.js";
import { VERSION } from "../version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerHandle {
  url: string;
  port: number;
  http: HttpServer;
  manager: SessionManager;
  terminals: TerminalManager;
  diag: DiagnosticLog;
  close(): Promise<void>;
}

/**
 * Builds the local Mendophyte server: the built web app, the REST API under
 * /api, the event stream at /ws and pty bridges at /ws/terminal/:id.
 * `port: 0` picks a free port (tests). `factory` swaps the real Agent SDK
 * session for a fake so the transport can be tested without a model.
 * `onShutdown` is what POST /api/shutdown triggers (the CLI's --replace).
 */
export async function createMendophyteServer(opts: { port: number; host?: string; factory?: SessionFactory; onShutdown?: () => void; diag?: DiagnosticLog }): Promise<ServerHandle> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const startedAt = new Date().toISOString();
  const diag = opts.diag ?? NULL_LOG;

  // One origin only. Browsers keep localStorage (layout, theme, UI size) and
  // per-site zoom separately for localhost and 127.0.0.1, so opening the app
  // by the other name looks like a different, differently-sized app. Page
  // navigations to the numeric host are sent to localhost.
  app.use((req, res, next) => {
    const hostHeader = String(req.headers.host ?? "");
    const accept = String(req.headers.accept ?? "");
    if (req.method === "GET" && /^(127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|$)/.test(hostHeader) && accept.includes("text/html")) {
      const p = hostHeader.split(":")[1] ? `:${hostHeader.split(":").pop()}` : "";
      diag.log("http", `redirecting ${hostHeader}${req.originalUrl} to localhost (same app, one set of browser settings)`);
      return res.redirect(302, `http://localhost${p}${req.originalUrl}`);
    }
    next();
  });

  // Every request, with a summary of the body and the outcome. The debug
  // log's own endpoints are skipped so tailing it doesn't fill it.
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/diag") || !req.path.startsWith("/api")) return next();
    const t0 = Date.now();
    res.on("finish", () => {
      const body = req.method === "GET" || req.method === "HEAD" ? "" : ` body=${brief(req.body, 300)}`;
      diag.log("http", `${req.method} ${req.originalUrl} → ${res.statusCode} in ${Date.now() - t0}ms${body}`);
    });
    next();
  });

  // src/server/index.ts -> dist/server/index.js at runtime, so this
  // walks up two levels to the package root, then into public/.
  const publicDir = path.resolve(__dirname, "../../public");
  app.use(express.static(publicDir));

  const manager = new SessionManager({ factory: opts.factory });
  const terminals = new TerminalManager();
  manager.on("session.removed", (id) => terminals.killForSession(id));

  // Everything the manager sees, summarised. Raw SDK messages are noisy
  // and already visible in the Transcript panel, so they are counted, not
  // written; everything else is one line each.
  let rawMessages = 0;
  manager.on("session.created", (s) => diag.log("session", `created ${s.id} repo=${s.repoDir} model=${s.model ?? "default"} artifacts=${s.artifactHome}`));
  manager.on("session.updated", (s) => diag.log("session", `${s.id} status=${s.status}${s.lastError ? ` error=${brief(s.lastError, 200)}` : ""} phase=${s.lastState?.phase ?? "-"} live=${s.livePhase ?? "-"} busy=${s.busy} yourTurn=${s.lastState?.your_turn_items.length ?? 0} approvals=${s.pendingApprovals} questions=${s.pendingQuestions}`));
  manager.on("session.removed", (id) => diag.log("session", `removed ${id}`));
  manager.on("session.event", (e) => {
    if (e.event === "message") {
      rawMessages += 1;
      if (rawMessages % 25 === 0) diag.log("session", `${e.sessionId} … ${rawMessages} raw SDK messages so far`);
      return;
    }
    const d: any = e.data;
    let what: string;
    switch (e.event) {
      case "assistant_text": what = `agent: ${brief(d?.text, 300)}`; break;
      case "tool_use": what = `tool ${d?.name} ${brief(d?.input, 300)}`; break;
      case "tool_allowed": what = `allowed ${d?.toolName ?? d?.name ?? ""} ${brief(d?.command ?? d?.input, 200)}`; break;
      case "turn": what = `turn ${d?.subtype} cost=${d?.total_cost_usd ?? "?"} turns=${d?.num_turns ?? "?"}${d?.timing ? ` latency: first text ${d.timing.firstTextMs ?? "?"}ms, result ${d.timing.wallMs}ms wall (${d.timing.waitingOnUserMs ?? 0}ms of it waiting on the user) / ${d.timing.apiMs ?? "?"}ms api` : ""}${d?.stateError ? ` stateError=${brief(d.stateError, 200)}` : ""}`; break;
      case "user_text": what = `${d?.kickoff ? "kickoff" : "user"}: ${brief(d?.text, 200)}`; break;
      case "state": what = `state phase=${d?.phase} complete=${d?.phase_complete} yourTurn=${brief((d?.your_turn_items ?? []).map((i: any) => `${i.id}:${i.kind}:${i.blocks}`), 300)}`; break;
      case "error": what = `ERROR ${brief(d?.message ?? d, 400)}`; break;
      case "verification": what = `verification ${d?.allPassed ? "all passed" : `${d?.counts?.failed ?? "?"} failed`} (${d?.results?.length ?? "?"} checks) run=${d?.id ?? ""}`; break;
      default: what = `${e.event} ${brief(d, 200)}`;
    }
    diag.log(e.event === "error" ? "error" : e.event === "assistant_text" || e.event === "tool_use" ? "agent" : "session", `${e.sessionId} #${e.seq} ${what}`);
  });
  manager.on("approval.pending", (a) => diag.log("approval", `pending ${a.id} [${a.match.ruleId}] ${brief(a.command, 300)}`));
  manager.on("approval.resolved", (a, d) => diag.log("approval", `${d.approved ? "APPROVED" : "denied"} ${a.id} [${a.match.ruleId}] by ${d.decidedBy}${!d.approved && d.reason ? ` reason=${brief(d.reason, 200)}` : ""}`));
  manager.on("question.pending", (q) => diag.log("question", `pending ${q.id} ${brief(q.questions.map((x) => x.question), 300)}`));
  manager.on("question.resolved", (q, answered) => diag.log("question", `${answered ? "answered" : "dismissed"} ${q.id}`));
  terminals.on("created", (t: any) => diag.log("server", `terminal created ${t.id} session=${t.sessionId ?? ""}`));
  terminals.on("exit", (t: any) => diag.log("server", `terminal exit ${t.id} code=${t.exitCode ?? "?"}`));
  const onUncaught = (err: unknown) => diag.log("error", `uncaughtException ${err instanceof Error ? `${err.message} ${brief(err.stack, 600)}` : brief(err)}`);
  const onRejection = (err: unknown) => diag.log("error", `unhandledRejection ${err instanceof Error ? `${err.message} ${brief(err.stack, 600)}` : brief(err)}`);
  process.on("uncaughtExceptionMonitor", onUncaught);
  process.on("unhandledRejection", onRejection);

  // The browser posts its own entries (button presses, field changes,
  // store actions, JS errors) in small batches.
  const SOURCES: DiagSource[] = ["ui", "error"];
  app.post("/api/diag", (req, res) => {
    const entries = Array.isArray(req.body?.entries) ? (req.body.entries as any[]) : [];
    const clean: DiagEntry[] = entries.slice(0, 200).map((e) => ({
      at: typeof e?.at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(e.at) ? e.at : new Date().toISOString(),
      source: SOURCES.includes(e?.source) ? (e.source as DiagSource) : "ui",
      text: brief(String(e?.text ?? ""), 600),
    }));
    diag.logMany(clean);
    res.json({ ok: true, count: clean.length });
  });
  app.get("/api/diag", (req, res) => {
    const n = Math.min(2000, Math.max(20, Number(req.query.tail ?? 300) || 300));
    res.json({ path: diag.path, size: diag.size(), enabled: diag.isEnabled, tail: diag.tail(n) });
  });
  app.post("/api/diag/enabled", (req, res) => {
    diag.setEnabled(req.body?.enabled !== false);
    res.json({ enabled: diag.isEnabled });
  });
  app.get("/api/diag/download", (_req, res) => {
    res.setHeader("content-type", "text/markdown; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${path.basename(diag.path)}"`);
    res.sendFile(diag.path, (err) => { if (err && !res.headersSent) res.status(404).json({ error: "no log file yet" }); });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", name: "mendophyte", version: VERSION, pid: process.pid, startedAt, sessions: manager.list().length, pendingApprovals: manager.pendingApprovals().length });
  });
  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true, pid: process.pid });
    setTimeout(() => opts.onShutdown?.(), 50);
  });
  app.use("/api", apiRoutes(manager, terminals));

  const http = createServer(app);
  const { hub, term } = attachWebSockets(http, manager, terminals, diag);

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    http.once("error", (err: NodeJS.ErrnoException) => {
      reject(err.code === "EADDRINUSE" ? Object.assign(new Error(`Port ${opts.port} is already in use.`), { code: "EADDRINUSE" }) : err);
    });
    http.listen(opts.port, host, () => resolve());
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  diag.log("server", `listening on http://localhost:${port} (bound to ${host}; pid ${process.pid}; fake sessions: ${process.env.MENDOPHYTE_FAKE_SESSION === "1" ? "yes" : "no"})`);

  return {
    url: `http://localhost:${port}`,
    port,
    http,
    manager,
    terminals,
    diag,
    close: async () => {
      diag.log("server", "closing");
      process.off("uncaughtExceptionMonitor", onUncaught);
      process.off("unhandledRejection", onRejection);
      terminals.killAll();
      manager.closeAll();
      for (const c of hub.clients) c.terminate();
      for (const c of term.clients) c.terminate();
      await new Promise<void>((r) => hub.close(() => r()));
      await new Promise<void>((r) => term.close(() => r()));
      // Browser tabs hold keep-alive connections; without this, close() waits on them forever.
      http.closeAllConnections?.();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

/** Kept for the CLI: starts the server and resolves to its URL. */
export async function startServer(port: number, diagIn?: DiagnosticLog): Promise<{ url: string; logPath: string }> {
  let factory: SessionFactory | undefined;
  if (process.env.MENDOPHYTE_FAKE_SESSION === "1") {
    const { FakeSession } = await import("./fake-session.js");
    factory = (c) => new FakeSession(c);
    console.warn("MENDOPHYTE_FAKE_SESSION=1: sessions are scripted fakes, no agent runs.");
  }
  let shuttingDown = false;
  const shutdown = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nmendophyte: shutting down (${why})`);
    diag.log("server", `shutting down (${why})`);
    // Never hang the terminal: if a clean close stalls, exit anyway.
    setTimeout(() => process.exit(1), 4000).unref();
    void handle.close().finally(() => process.exit(0));
  };
  const diag = diagIn ?? new DiagnosticLog({ enabled: process.env.MENDOPHYTE_NO_DIAG !== "1" });
  const handle = await createMendophyteServer({ port, factory, onShutdown: () => shutdown("shutdown requested"), diag });
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGHUP", () => shutdown("terminal closed"));
  return { url: handle.url, logPath: diag.path };
}
