import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { ApprovalDecision } from "../orchestrator/index.js";
import type { SessionManager } from "./session-manager.js";
import type { TerminalManager } from "./terminals.js";
import { NULL_LOG, brief, type DiagnosticLog } from "./diag.js";

/**
 * Two websocket routes on one HTTP server:
 *
 * `/ws` — the event hub. Outbound (server -> client), all JSON with a `type`:
 *   snapshot           { sessions, approvals }               on connect
 *   session.created    { session }
 *   session.updated    { session }
 *   session.removed    { id }
 *   session.event      { sessionId, seq, at, event, data }   every orchestrator event
 *   approval.pending   { approval }                          a guardrail command is waiting
 *   approval.resolved  { approval, decision }
 *   terminal.created / terminal.exit / terminal.closed { terminal }
 *   error              { message, inReplyTo? }
 * Inbound (client -> server):
 *   { type: "approval.resolve", id, approved, reason? }
 *   { type: "session.send", sessionId, text }
 *   { type: "replay", sessionId, afterSeq? }
 *
 * `/ws/terminal/<id>` — raw pty traffic for one terminal. Binary frames are
 * bytes in both directions; text frames are JSON control messages
 * (`resize`, `input` inbound; `hello`, `exit` outbound).
 */
export function attachWebSockets(server: HttpServer, manager: SessionManager, terminals: TerminalManager, diag: DiagnosticLog = NULL_LOG): { hub: WebSocketServer; term: WebSocketServer } {
  const hub = new WebSocketServer({ noServer: true });
  const term = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/ws") {
      hub.handleUpgrade(req, socket, head, (ws) => hub.emit("connection", ws, req));
      return;
    }
    const m = /^\/ws\/terminal\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (m) {
      term.handleUpgrade(req, socket, head, (ws) => terminals.attach(m[1], ws));
      return;
    }
    socket.destroy();
  });

  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of hub.clients) if (c.readyState === WebSocket.OPEN) c.send(text);
  };

  manager.on("session.created", (session) => broadcast({ type: "session.created", session }));
  manager.on("session.updated", (session) => broadcast({ type: "session.updated", session }));
  manager.on("session.removed", (id) => broadcast({ type: "session.removed", id }));
  manager.on("session.event", (e) => broadcast({ type: "session.event", ...e }));
  manager.on("approval.pending", (approval) => broadcast({ type: "approval.pending", approval }));
  manager.on("approval.resolved", (approval, decision) => broadcast({ type: "approval.resolved", approval, decision }));
  manager.on("question.pending", (question) => broadcast({ type: "question.pending", question }));
  manager.on("question.resolved", (question, answered) => broadcast({ type: "question.resolved", question, answered }));
  terminals.on("created", (t) => broadcast({ type: "terminal.created", terminal: t }));
  terminals.on("exit", (t) => broadcast({ type: "terminal.exit", terminal: t }));
  terminals.on("closed", (t) => broadcast({ type: "terminal.closed", terminal: t }));

  hub.on("connection", (socket: WebSocket) => {
    diag.log("ws", `client connected (${hub.clients.size} open)`);
    socket.on("close", () => diag.log("ws", `client disconnected (${hub.clients.size} open)`));
    socket.send(JSON.stringify({ type: "snapshot", sessions: manager.list(), approvals: manager.pendingApprovals(), questions: manager.pendingQuestions(), terminals: terminals.list() }));

    socket.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        diag.log("ws", "inbound: invalid JSON");
        return socket.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
      }
      diag.log("ws", `inbound ${msg?.type} ${brief(msg, 300)}`);
      try {
        switch (msg?.type) {
          case "approval.resolve": {
            const decision: ApprovalDecision = msg.approved
              ? { approved: true, decidedBy: "ws" }
              : { approved: false, reason: typeof msg.reason === "string" ? msg.reason : undefined, decidedBy: "ws" };
            if (!manager.resolveApproval(String(msg.id), decision)) {
              socket.send(JSON.stringify({ type: "error", message: `no pending approval ${msg.id}`, inReplyTo: msg.type }));
            }
            return;
          }
          case "question.answer":
            if (!manager.answerQuestion(String(msg.id), msg.answers ?? {})) {
              socket.send(JSON.stringify({ type: "error", message: `no pending question ${msg.id}`, inReplyTo: msg.type }));
            }
            return;
          case "question.dismiss":
            manager.dismissQuestion(String(msg.id), typeof msg.reason === "string" ? msg.reason : undefined);
            return;
          case "session.send":
            manager.send(String(msg.sessionId), String(msg.text ?? ""));
            return;
          case "replay":
            for (const e of manager.events(String(msg.sessionId), Number(msg.afterSeq ?? 0))) {
              socket.send(JSON.stringify({ type: "session.event", ...e }));
            }
            return;
          default:
            socket.send(JSON.stringify({ type: "error", message: `unknown message type ${msg?.type}` }));
        }
      } catch (e) {
        socket.send(JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e), inReplyTo: msg?.type }));
      }
    });
  });

  return { hub, term };
}
