#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import { startServer } from "./server/index.js";
import { probeInstance, requestShutdown } from "./server/probe.js";

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
      } else {
        console.log(existing === "other" ? `Port ${port} is in use, but not by Mendophyte.` : `Nothing is running on port ${port}.`);
        process.exitCode = existing === "other" ? 1 : 0;
      }
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

    let url: string;
    try {
      url = await startServer(port);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
      return;
    }
    console.log(`mendophyte running at ${url}  (Ctrl-C to stop)`);

    if (opts.open) {
      await open(url);
    }
  });

program.parseAsync(process.argv);
