#!/usr/bin/env node
import { Command } from "commander";
import open from "open";
import { startServer } from "./server/index.js";

const program = new Command();

program
  .name("mendophyte")
  .description(
    "Local dev cockpit for AI-assisted open-source contribution work"
  )
  .option("-p, --port <number>", "port to run the local server on", "4317")
  .option("--no-open", "do not open the browser automatically")
  .action(async (opts: { port: string; open: boolean }) => {
    const port = parseInt(opts.port, 10);

    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }

    const url = await startServer(port);
    console.log(`mendophyte running at ${url}`);

    if (opts.open) {
      await open(url);
    }
  });

program.parseAsync(process.argv);
