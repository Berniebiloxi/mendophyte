import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one version number, read from package.json at runtime so the health
 * endpoint, the SDK client-app string, the MCP server and the About box
 * never drift from what `npm version` set. The web bundle gets the same
 * value at build time through Vite (see web/vite.config.ts).
 */
function readVersion(): string {
  try {
    // src/version.ts -> dist/version.js at runtime; package.json is one level up either way.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = readVersion();
