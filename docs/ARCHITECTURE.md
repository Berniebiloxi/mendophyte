# Mendophyte — architecture and reference

The detailed material that used to live in the README: how the pieces fit,
the server API the panels talk to, the orchestration layer you can drive
from a terminal, and the project layout. For installing and using the
app, see the [README](../README.md). For the original brief and the
decisions behind it, see [handoff.md](handoff.md). The six meta-prompt
files in `prompts/` are the authoritative spec and are shipped verbatim.

## Developing the UI

```
npm run dev            # node server on :4317 (real Agent SDK sessions)
npm run dev:web        # vite dev server on :5173, proxying /api and /ws to :4317
```

To work on panels without spending tokens, run the server with a
scripted fake session that walks through questions, a guardrail
confirmation, a locked diff and verification:

```
MENDOPHYTE_FAKE_SESSION=1 npm run dev
```

`npm run build` compiles the server to `dist/` and the web app into
`public/`, which is what ships.

On node-pty (the terminal panel's native dependency): version 1.1.0
ships prebuilt binaries for macOS and Windows on both architectures, but
not Linux, where `npm install` compiles it with node-gyp (python3 plus a
C++ toolchain; a few seconds where those exist). If it fails to load, the
server still starts and the Terminal panel reports the error instead.

The terminal is deliberately the user's shell, not the agent's: nothing
typed there passes through the guardrails or reaches the agent. The
agent's own activity is the Conversation and Transcript panels.

## Server API

`mendophyte` serves the placeholder page plus a REST API under `/api` and
a websocket event stream at `/ws`. Commands go over REST; everything the
session does arrives on the socket.

```
POST   /api/preflight                 { repoDir, repoUrl? }        -> { report, facts }
GET    /api/sessions
POST   /api/sessions                  { repoDir, artifactHome?, repoUrl?, model?, preflight?, kickoff? } -> 201 { session }
GET    /api/sessions/:id              -> { session, approvals }
GET    /api/sessions/:id/events?after=N   replay from the per-session buffer (last 500)
GET    /api/sessions/:id/preflight    -> { report, facts }
GET    /api/sessions/:id/fragility    -> { report, facts, cached }  (?subpath=&since=&refresh=)
POST   /api/fragility                 { repoDir, subpath?, since? } -> { report, facts }
GET    /api/sessions/:id/verification -> { detected, runs }   history, newest first (agent and UI runs alike)
POST   /api/sessions/:id/verification/detect { subpath? }
POST   /api/sessions/:id/verification { useDetected?, includeKinds?, checks?[{command,cwd,successRule}], timeoutMinutes?, failFast? } -> { run, facts }
POST   /api/verification/detect       { repoDir, subpath? }
GET    /api/sessions/:id/diff         -> { diff }  working tree vs HEAD incl. untracked (?untracked=0)
GET    /api/sessions/:id/files        -> { listing } tracked + untracked files; ?fragility=1 adds heat
GET    /api/sessions/:id/file?path=   -> { file }  read-only, confined to the clone (symlinks out refused)
GET    /api/sessions/:id/artifacts    -> artifact-home listing (also pushed as `artifacts` events on change)
GET    /api/sessions/:id/artifacts/file?name=
GET    /api/sessions/:id/benchmarks  -> { detection, runs }
POST   /api/sessions/:id/benchmarks/run  { command, label?, tool?, cwd?, timeoutMinutes? } -> 201 { run }
POST   /api/sessions/:id/benchmarks/:runId/label { label }
GET    /api/sessions/:id/benchmarks/compare?baseline=&after= -> { comparison, facts }
GET    /api/sessions/:id/feedback    -> { log }   Artifact F entries (append-only file in the artifact home)
POST   /api/sessions/:id/feedback    { lesson, tags?, source? } -> 201 { entry, log }
POST   /api/sessions/:id/feedback/:entryId/stale { stale }     flag when live recon contradicts an entry
GET    /api/sessions/:id/submission  -> { report, pollingSec, facts }  (?refresh=1 recomputes)
POST   /api/sessions/:id/submission/refresh { fetch? }
POST   /api/sessions/:id/submission/poll    { intervalSec | null }   forge polling, 15s floor
GET    /api/terminals/host            -> { platform, shell, user, ptyError }
GET    /api/sessions/:id/terminals
POST   /api/sessions/:id/terminals    { cols?, rows? } -> 201 { terminal }   then connect ws to /ws/terminal/:tid
DELETE /api/sessions/:id/terminals/:tid
POST   /api/diff                      { repoDir }
POST   /api/sessions/:id/messages     { text }
POST   /api/sessions/:id/interrupt
POST   /api/sessions/:id/end          finish the current turn and exit cleanly
DELETE /api/sessions/:id              force-close and forget
GET    /api/approvals                 guardrail commands waiting on a human
POST   /api/approvals/:id             { approved, reason? }
GET    /api/questions                 AskUserQuestion calls waiting on a human
POST   /api/sessions/:id/snapshot     write a Markdown session record to <artifactHome>/snapshots/
GET    /api/sessions/:id/snapshot.md  the same record as a download
POST   /api/projects/:name/rename     { to }        rename an artifact home under ~/.mendophyte
POST   /api/projects/:name/move       { to }        move it to any new path
DELETE /api/projects/:name                          delete it (refused while a session uses it)
GET    /api/diag                      debug log path, size and tail; /api/diag/download serves the file
POST   /api/diag                      { entries: [{ at, source, text }] } from the browser
POST   /api/questions/:id             { answers: { "<question>": "label" | ["a","b"] } } or { dismiss: true }
```

Socket frames on `/ws` (JSON, `type` field): `snapshot` on connect, then
`session.created|updated|removed`, `session.event` (every orchestrator
event: init, assistant_text, tool_use, turn with structured state, raw
message, verification, artifacts, error, end), `approval.pending`,
`approval.resolved`, `question.pending`, `question.resolved`,
`terminal.created|exit|closed`. Inbound the socket accepts
`approval.resolve`, `question.answer`, `session.send` and `replay`.

`/ws/terminal/:tid` carries one pty: binary frames are bytes both ways,
text frames are JSON control (`resize`, `input` in; `hello`, `exit` out).
Scrollback (last 256 KB) is replayed on connect.

## Orchestration layer (no frontend needed)

Run a real session against a repository clone from the terminal:

```
npm run orchestrate -- --repo /path/to/clone [--repo-url https://...] [--model haiku]
```

It kicks off the meta-prompt (`00-entry.md`, Phase 0 step 0), prints
what the agent says and does, shows the structured dashboard state after
every turn, and asks `y/N` in the terminal whenever a guardrail command
(commit, push, force-push, hard reset, history rewrite, recursive delete,
opening a PR, or any other write to the forge such as creating an issue,
commenting, reviewing, forking or a mutating `gh api` call) needs your confirmation. Type to reply; `/end` finishes.

Artifacts default to `~/.mendophyte/<repo-name>/`. The six meta-prompt
files are read by the agent from `prompts/`; they are the authoritative
spec and are shipped verbatim. The original project brief is in
`docs/handoff.md`.

Before the kickoff, the deterministic Phase 0 checks run locally and are
handed to the agent as already-observed facts (capability tier from
`gh auth status` / `git ls-remote` / an anonymous forge API call, repo
health from that same API response, every CONTRIBUTING / PR-template /
agent-instruction / CLA file with its AI- and CLA-related lines flagged,
artifact-home contents, git state, a scale read, and the local machine).
To see that block on its own, without a session:

```
npm run preflight -- --repo /path/to/clone [--json]
```

Pass `--show-preflight` to the orchestrate harness to print it before the
session starts, or `--no-preflight` to let the agent probe on its own.

The Phase 2 fragility-map inputs (file churn from `git log --numstat`,
fix/revert clustering by file and directory with example commits,
TODO/FIXME/HACK/XXX density from `git grep`, and the weak "untouched in
the window" count) are computed by Mendophyte too, but delivered
differently: the session exposes them to the agent as an in-process tool,
`mcp__mendophyte__fragility_map`, which the system prompt tells it to
call on entering Phase 2 (optionally narrowed with `subpath` later). That
keeps Phase 2 material out of the Phase 0 context and spends no agent
turns re-deriving it. The same report is available to the UI at
`GET /api/sessions/:id/fragility` and `POST /api/fragility`, and from the
terminal:

```
npm run fragility -- --repo /path/to/clone [--subpath src/parser] [--since "2 years"] [--json]
```

Verification (Phase 4 step 10, Phase 5E) follows the same pattern with two
tools. `detect_verification_commands` reads the project's own config
(package.json scripts, Cargo.toml, go.mod, pyproject/setup.cfg, Makefile,
pre-commit), the toolchain versions it pins versus what is installed, and
the literal `run:` steps in its CI workflows. `run_verification` actually
runs checks (the detected default set, or commands the agent passes from
CONTRIBUTING or CI) and returns each one's real exit code, duration and
output tail, with full logs under `<artifact-home>/logs/`. That report is
the only basis on which the agent may say a check passed; the same
results stream to the UI as `verification` events and sit in a
per-session history, so a claim the tool didn't make is visible as such.
Commands on the guardrail list are refused by the runner and must go
through Bash and the confirmation modal. From the terminal:

```
npm run verify -- --repo /path/to/clone            # detect only
npm run verify -- --repo /path/to/clone --run      # run the detected set (exit 1 if anything fails)
```

Tests:

```
npm run test:browser # drives the built UI in a local Chrome against the fake session; screenshots in test/browser/shots/
npm test            # unit: guardrail matching, 00-entry.md section extraction
npm run test:live   # integration against real Claude Code sessions (haiku, a few cents)
```

## Project layout

```
src/
  cli.ts                      entry point — arg parsing, starts the server
  server/
    index.ts                  builds the local server: static page, /api, /ws
    session-manager.ts        owns live sessions; sequenced event buffer; approvals across sessions
    routes.ts                 REST commands
    ws.ts                     websocket routes: event hub at /ws, pty bridge at /ws/terminal/:id
    terminals.ts              node-pty terminals per session, scrollback ring, lifecycle
  orchestrate-cli.ts          terminal harness for the orchestration layer
  orchestrator/
    session.ts                one streaming-input query() session: input queue,
                              canUseTool + PreToolUse guardrail floor, per-turn state
    guardrails.ts             the command patterns that must pause for confirmation
    approvals.ts              pending-approval broker (events; transport-agnostic)
    schema.ts                 structured-output schema for dashboard state (zod → JSON Schema):
                              phase, your-turn queue, and the optional Phase 3 triage block
    entry-sections.ts         slices 00-entry.md's three persistent sections into the system prompt
    preflight/                deterministic Phase 0 checks (forge detection, capability tier,
                              repo health, policy/CLA file scan, local facts) + facts formatter
    fragility/                Phase 2 fragility-map inputs from git (churn, fix clusters, markers)
    verification/             detect a project's own checks; run them with real exit codes and logs
    git-diff.ts               real working-tree diff for the diff/verification panel
    submission.ts             Phase 5 facts: PR, CI, template compliance, DCO, branch sync
    feedback-log.ts           Artifact F: fixed on-disk entry format, append, stale flag, facts
    benchmark.ts              benchmark detection, parsers (criterion, go bench, pytest-benchmark,
                              hyperfine), persisted runs, baseline/after comparison with noise test
    tools.ts                  Mendophyte's in-process MCP tools (fragility_map, detect_/run_verification,
                              submission_status, feedback_log, benchmark)
  preflight-cli.ts            prints the pre-flight facts block for a clone; no model involved
  fragility-cli.ts            prints the fragility-map inputs for a clone; no model involved
  verify-cli.ts               detects and optionally runs a clone's checks; no model involved
  server/fake-session.ts      scripted stand-in for UI development (MENDOPHYTE_FAKE_SESSION=1)
web/                          the React + dockview cockpit (vite; builds into public/)
  src/theme.css               Vine and Minimal tokens, light and dark, dockview binding
  src/store.ts                websocket client + UI state (replays the server buffer on reconnect)
  src/layout.ts               default layout, persistence, named layouts
  src/panels/                 one file per panel
public/                       built web app (generated by `npm run build`; not committed)
prompts/                      00-entry.md … 05-submission.md, the meta-prompt, verbatim
docs/handoff.md               the original project brief and architecture decisions
test/                         unit tests; test/live/ needs MENDOPHYTE_LIVE=1 and a logged-in Claude Code
```

