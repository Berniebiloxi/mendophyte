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
export function childEnv(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k === "CLAUDE_CODE_CHILD_SESSION" || k === "INIT_CWD") continue;
    if (/^npm_/i.test(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out;
}
