#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import { startServer } from "./server/index.js";
import { DiagnosticLog } from "./server/diag.js";
import { findListener, killHolder, probeInstance, requestShutdown } from "./server/probe.js";

const program = new Command();

program
  .name("mendophyte")
  .description(
    "Local dev cockpit for AI-assisted open-source contribution work"
  )
  .option("-p, --port <number>", "port to run the local server on", "4317")
  .option("--no-open", "do not open the browser automatically")
  .option("--replace", "if a Mendophyte instance already owns the port, ask it to shut down and take over")
  .option("--stop", "stop the Mendophyte instance on the port and exit")
  .action(async (opts: { port: string; open: boolean; replace?: boolean; stop?: boolean }) => {
    const port = parseInt(opts.port, 10);

    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }

    const existing = await probeInstance(port);

    if (opts.stop) {
      if (existing && existing !== "other") {
        const ok = await requestShutdown(port);
        console.log(ok ? `Stopped the Mendophyte instance on port ${port}${existing.pid ? ` (pid ${existing.pid})` : ""}.` : `Asked the instance on port ${port} to stop, but it is still answering.`);
        process.exitCode = ok ? 0 : 1;
        return;
      }
      const holder = existing === null ? await findListener(port) : null;
      if (holder?.looksLikeMendophyte) {
        const ok = await killHolder(holder, port);
        console.log(ok ? `Stopped a stuck Mendophyte process on port ${port} (pid ${holder.pid}).` : `Could not stop pid ${holder.pid}; try: kill -9 ${holder.pid}`);
        process.exitCode = ok ? 0 : 1;
        return;
      }
      if (holder) {
        console.log(`Port ${port} is held by pid ${holder.pid} (${holder.command ?? "unknown command"}), which is not Mendophyte; leaving it alone.`);
        process.exitCode = 1;
        return;
      }
      console.log(existing === "other" ? `Port ${port} is in use, but not by Mendophyte.` : `Nothing is running on port ${port}.`);
      process.exitCode = existing === "other" ? 1 : 0;
      return;
    }

    if (existing && existing !== "other") {
      if (opts.replace) {
        console.log(`Replacing the Mendophyte instance on port ${port}${existing.pid ? ` (pid ${existing.pid}` : ""}${existing.sessions ? `, ${existing.sessions} session(s) will be closed` : ""}${existing.pid ? ")" : ""}…`);
        const ok = await requestShutdown(port);
        if (!ok) {
          console.error(`The old instance did not release port ${port}. Stop it manually${existing.pid ? ` (kill ${existing.pid})` : ""} or use --port.`);
          process.exitCode = 1;
          return;
        }
      } else {
        console.error(
          [
            `Mendophyte is already running at ${existing.url}${existing.pid ? ` (pid ${existing.pid}` : ""}${existing.startedAt ? `${existing.pid ? ", " : " ("}since ${existing.startedAt}` : ""}${existing.pid || existing.startedAt ? ")" : ""}.`,
            `  To use it:           open ${existing.url}`,
            `  To restart on it:    mendophyte --replace   (closes its ${existing.sessions ?? 0} session(s))`,
            `  To stop it:          mendophyte --stop`,
            `  To run another copy: mendophyte --port <other>`,
          ].join("\n")
        );
        process.exitCode = 1;
        return;
      }
    } else if (existing === "other") {
      console.error(`Port ${port} is in use by another program. Use --port <other>.`);
      process.exitCode = 1;
      return;
    }

    // The debug log starts before the server so startup output lands in it too.
    const diag = new DiagnosticLog({ enabled: process.env.MENDOPHYTE_NO_DIAG !== "1" });
    for (const level of ["log", "warn", "error"] as const) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        orig(...args);
        const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        // The SDK warns that pre-approved tools bypass canUseTool. That is by design here
        // (the guardrails run as a PreToolUse hook), so it is information, not an error.
        const expected = /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/.test(text);
        diag.log(level === "error" && !expected ? "error" : "server", `[stdout] ${expected ? "expected SDK note (pre-approved tools skip canUseTool; guardrails run as a hook): " : ""}${text.slice(0, 400)}`);
      };
    }
    process.on("warning", (w) => diag.log("server", `node warning: ${w.name}: ${w.message}`));
    diag.log("server", `launched: node ${process.version}, argv ${JSON.stringify(process.argv.slice(2))}${process.env.npm_lifecycle_event ? `, via npm ${process.env.npm_lifecycle_event} (${process.env.npm_config_user_agent ?? "npm"})` : ""}, cwd ${process.cwd()}`);
    let url: string;
    let logPath = "";
    try {
      ({ url, logPath } = await startServer(port, diag));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EADDRINUSE") {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
        return;
      }
      // Bound but not answering as Mendophyte: find out who, and clear a stuck older instance on request.
      const holder = await findListener(port);
      if (holder?.looksLikeMendophyte && opts.replace) {
        console.log(`Port ${port} is held by a Mendophyte process that isn't responding (pid ${holder.pid}); stopping it…`);
        if (await killHolder(holder, port)) {
          try {
            ({ url, logPath } = await startServer(port, diag));
          } catch (e2) {
            console.error(e2 instanceof Error ? e2.message : String(e2));
            process.exitCode = 1;
            return;
          }
        } else {
          console.error(`Could not free port ${port}. Try: kill -9 ${holder.pid}`);
          process.exitCode = 1;
          return;
        }
      } else {
        console.error(
          holder
            ? [
                `Port ${port} is held by pid ${holder.pid}${holder.command ? ` (${holder.command.slice(0, 120)})` : ""}, which is not answering as Mendophyte.`,
                holder.looksLikeMendophyte
                  ? `  It looks like a stuck Mendophyte process. Run: mendophyte --replace   (or: kill ${holder.pid})`
                  : `  Stop that program or run: mendophyte --port <other>`,
              ].join("\n")
            : `Port ${port} is in use, but no owning process could be identified (a stale socket, or a process owned by another user). Wait a moment and retry, or use --port <other>.`
        );
        process.exitCode = 1;
        return;
      }
    }
    console.log(`mendophyte running at ${url}  (Ctrl-C to stop)`);
    console.log(`debug log: ${logPath}`);

    if (opts.open) {
      await open(url);
    }
  });

program.parseAsync(process.argv);
