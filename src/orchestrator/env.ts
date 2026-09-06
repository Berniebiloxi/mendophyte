/**
 * The environment handed to every child process Mendophyte starts: the
 * agent's Claude Code process, the user's terminal shells, verification
 * and benchmark runs, forge probes.
 *
 * Two families of variables are stripped on purpose:
 *
 * - `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION`: set when Mendophyte itself
 *   was launched from inside a Claude Code terminal. Inheriting them makes
 *   the SDK refuse to start a nested session and makes shells think they
 *   are the agent's.
 * - `npm_*` and `INIT_CWD`: set by `npm start`. Inherited by a shell in the
 *   target repository they make every nested npm/yarn/pnpm command act on
 *   Mendophyte's own package instead of the repo the user is in
 *   (`npm_config_local_prefix`, `npm_package_json`, `npm_lifecycle_*`), so
 *   "recommended" commands like `npm audit fix` fail or fix the wrong tree.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directories user-installed toolchains live in; only those that exist are added, and only if missing. */
export function userToolDirs(home = os.homedir()): string[] {
  const h = (...p: string[]) => path.join(home, ...p);
  const candidates =
    process.platform === "win32"
      ? [h("AppData", "Roaming", "npm"), h(".bun", "bin"), h(".cargo", "bin"), h("go", "bin"), h(".deno", "bin"), h("scoop", "shims"), h(".local", "bin")]
      : [h(".local", "bin"), h(".bun", "bin"), h(".cargo", "bin"), h("go", "bin"), h(".deno", "bin"), h(".volta", "bin"), h(".pyenv", "shims"), h(".rbenv", "shims"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
  return candidates.filter((d) => existsSync(d));
}

export function childEnv(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k === "CLAUDE_CODE_CHILD_SESSION" || k === "INIT_CWD") continue;
    if (/^npm_/i.test(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  const pathKey = Object.keys(out).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  const have = new Set((out[pathKey] ?? "").split(sep).filter(Boolean));
  const add = userToolDirs().filter((d) => !have.has(d));
  if (add.length) out[pathKey] = [...(out[pathKey] ? [out[pathKey]] : []), ...add].join(sep);
  return out;
}
