# Mendophyte — project context and next task

You're picking up work on **Mendophyte**, a local dev cockpit for AI-assisted
open-source contribution work, built on the Claude Agent SDK. This file is a
full handoff of everything decided so far, so you have complete context
without needing it re-explained.

## What this project is

Mendophyte is a Claude Code / Aider-style tool, but purpose-built around a
specific meta-prompt for open-source bug-fixing and performance work, rather
than being a general-purpose coding agent. The meta-prompt is the "brain" of
the app — it's the original six files, included exactly as written in this
project folder:

- `00-entry.md` — Phase 0 (entry questions), "How This Splits Between Us"
  (the human/agent handoff rules), the Artifacts list (A–F), and the
  Standing Guardrails. This file's three named sections apply throughout
  every phase and are never superseded by a phase file.
- `01-recon.md` — Phase 1: Reconnaissance
- `02-orientation.md` — Phase 2: Orientation
- `03-triage.md` — Phase 3: Triage
- `04-fix.md` — Phase 4: The Fix
- `05-submission.md` — Phase 5: Submission

Each phase file is read by the agent at the moment it enters that phase,
not before, per `00-entry.md`'s own loading rules.

**Read these six files directly and treat them as the authoritative spec —
not the summaries and paraphrases elsewhere in this document.** Everything
below is my own condensation of decisions made while discussing them; where
anything here seems to drift from what a phase file actually says, the
phase file wins. Nothing here is a substitute for reading them, and they
are not something to rewrite or simplify.

The visual identity is a vine growing along a wall that mends things —
phases are nodes along a growing vine, artifacts are what it buds off,
verification passing is the "mend." Keep this as a real design constraint
(a signature default theme, not just a one-off splash page), not just
decoration on top.

## Architecture decisions already made

**Distribution: npm package, not Electron, not a hosted service.**
The intended audience is a handful of friends who already run Claude Code
locally on their own workstations (Windows, Mac, Linux) — not people with
self-hosted infrastructure. So:
- Ships as an npm package (`npx mendophyte` or `npm install -g`).
- On run: starts a local Node server (the orchestrator + a static frontend
  bundle) and opens the default browser to `localhost:<port>`.
- Each person's instance talks to *their own* local Claude Code
  session/auth/git credentials — there is no shared backend, no hosting
  cost, no cross-machine session question.
- Artifact home defaults to something like `~/.mendophyte/<repo-name>/`.
- The one platform-sensitive dependency is `node-pty` for the terminal
  panel (needs a real pty). It ships prebuilt binaries per platform via
  npm's own tooling — validate early that this resolves cleanly on
  Windows, Mac, and Linux before building much on top of it.
- Electron was considered and explicitly rejected for now (native menu bar
  and detachable windows would be nice, but the packaging/signing/
  notarization tax and the local-vs-remote execution question aren't worth
  it for this audience). Revisit only if the audience shifts toward
  non-technical users.

**Session and context management (Claude Agent SDK, TypeScript).**
- Use `query()` in **streaming input mode** (an async generator of user
  messages) so the orchestrator can push things into a live session later
  — a submitted hypothesis, a guardrail confirmation, etc. — rather than
  starting a new query per interaction.
- Put `00-entry.md`'s three persistent sections into `appendSystemPrompt`
  once, at session start, rather than re-injecting them every phase.
- The phase files (`01`–`05`) are read by the agent itself with its own
  Read tool at the moment it enters that phase, per the meta-prompt's own
  design — the orchestrator decides *when* a session starts or resumes,
  it does not spoon-feed phase content into context.
- `additionalDirectories` points at the artifact home so the agent can
  read/write Artifacts A–F as real files living outside the target repo,
  per the meta-prompt's own rule that they're never staged/committed/
  pushed.
- Phase 0 step 0's resume check is a **fresh session**, not a continuation
  of a prior one: reseed `appendSystemPrompt`, hand it precomputed
  deterministic facts (see below), let it read `00-entry.md` and jump to
  whichever phase the artifacts show was in progress.

**Deterministic checks run by the orchestrator, not asked of the model.**
Several things the meta-prompt asks the model to "check" are actually
plain shell/grep operations with no need for a model turn:
- Phase 0 steps 3–5 (`gh auth status`, `git ls-remote`, anonymous API
  probe, scanning for `CONTRIBUTING.md`/`AGENTS.md`/CLA language) —
  run these directly, inject the results as known facts.
- Phase 2's fragility map inputs (git churn via `git log --numstat`,
  fix/revert-message clustering, TODO/FIXME/HACK density) — compute
  directly, feed the summary into context.
- Phase 4/5 verification (lint, format, tests, CI) — actually run these
  commands and use the real exit code. Never let the model self-report a
  checkmark; this is the direct enforcement of the guardrail against
  fabricating a claim that something was verified.
This matters for cost and turn count as well as trust — don't spend agent
turns re-deriving things a script already knows.

**Dashboard state: structured outputs, not marker-parsing or regex.**
The SDK's structured-outputs feature lets you define a JSON Schema and
still get free multi-step tool use from the agent, with the final result
guaranteed to validate against your schema. Use this for every panel that
needs machine-readable state: current phase, "your turn" queue items,
triage candidates with per-criterion scores, the danger rating, which
artifacts got touched this turn. **Open question to resolve before
committing to a session shape:** whether the schema can vary phase-to-phase
within one long streaming session, or is fixed per `query()` call — check
this against current SDK docs, since it decides between one long-lived
session for the whole workflow vs. a fresh session per phase.

**Guardrails: a separate, synchronous layer from dashboard state.**
This fires per tool call in real time, independent of end-of-turn
structured output. Permission evaluation order in the SDK: hooks run
first, then deny rules, then the active permission mode, then allow
rules, then `canUseTool` for anything not already resolved.
- Allow read-only tools (Read, Grep, Glob) outright via `allowedTools` so
  normal exploration isn't modal-spammed.
- Route Bash commands matching the guardrail list (`git push`,
  `git commit`, force-push variants, `rm -rf`, `git reset --hard`,
  history rewrites) through `canUseTool`, which blocks on a promise until
  the GUI shows a confirm modal (exact command + target shown) and the
  user clicks through.
- Back this with a `PreToolUse` hook as the hard floor — a hook returning
  deny blocks the tool even in `bypassPermissions` mode or with
  `--dangerously-skip-permissions`, so the guardrail can't be silently
  skipped even if a session ends up in a looser mode later.
- Worth reading up on the SDK's **file checkpointing** feature too —
  looks like a good fit for Phase 3's "dignified bail-out back to the
  candidate list" and for Phase 4's "don't show the diff until a
  hypothesis is stated" (checkpoint before an attempt starts, so bailing
  is a clean revert). Not yet verified in detail.

## Planned panel inventory (dockable, Unreal-Engine-style layout)

Using a React docking library (dockview or rc-dock) inside one browser
window — panels can be dragged, split, floated, and closed, with a
save/load/reset layout capability. Not native OS windows (that would
require Electron, rejected above).

- **Terminal** — xterm.js over a websocket bridge to `node-pty`, running
  the actual Claude Code / Agent SDK session live.
- **File tree** — overlaid with fragility data (churn/fix-cluster/TODO
  density) computed by the orchestrator, not a separate metrics panel.
- **Progress spine** — the vine motif; phase 0→5 as growth nodes, blooming
  as each artifact completes. Driven by structured-output state, not
  parsed prose.
- **Capability dashboard** — Phase 0's forge-access tier, repo health, AI
  policy, CLA status, hardware/OS — from the deterministic pre-flight
  checks, always visible.
- **"Your turn" queue** — the concrete enforcement of "How This Splits
  Between Us": diff/PR-draft panels stay locked until a queued item (state
  your hypothesis, find the line, explain this back to me) is submitted by
  the user. Ask the model to emit a structured marker for these
  (`your_turn_items` in the schema) rather than inferring from prose.
- **Triage board** (Phase 3 shallow pass) — one card per candidate, the
  named scoring criteria as visible tags/columns, not prose to re-read.
  Becomes a single card with a **danger gauge** (contained → ripples →
  blast-radius) for the deep pass on the chosen task.
- **Diff / verification panel** — real `git diff` (rendered with something
  like diff2html), plus a literal checklist from actually-run lint/format/
  test commands.
- **Recon Notes (Artifact A) & Glossary (Artifact D)** — rendered markdown,
  file-watched for live updates; glossary terms link to where they were
  introduced.
- **Fix & test status (Artifact C)** — real pass/fail from actually
  executing the regression test in the sandboxed environment.
- **Benchmark panel** (perf sessions only) — parse the project's own
  benchmark tool output (e.g. `criterion`'s JSON) into a chart with
  variance/warm-up shown, not a single number.
- **Submission panel (Artifact E)** — PR template compliance as a diffable
  check, CI status polled from the forge API on a timer, not relayed
  through the model.
- **Feedback log (Artifact F)** — simple append-only, searchable/taggable
  list.
- **Resume/diff panel** — Phase 0 step 0's resume check, rendered as an
  actual diff against the last session's artifact snapshot.

## Menu bar and preferences (emulated in HTML, not native — see above)

- **File** — new session, open project (list of prior repos by artifact
  home), save/load snapshot (bundles artifact home + agent session id —
  "load" should resume the actual SDK session where possible, not just
  reread static files), export (transcript/log/PR draft as markdown).
- **Edit** — find in artifacts/logs, clear terminal scrollback, copy
  selection, preferences.
- **View** — toggle each panel's visibility, reset layout to default,
  save/load named layouts (independent of any specific repo/session),
  theme switcher, terminal zoom/font size.
- **Help** — meta-prompt docs/README link, about/changelog, report an
  issue (repo link), check for updates.
- **Preferences** — log location (default `<artifact-home>/logs/`,
  overridable); theme (ship "Vine" — the green/teal branded look — as
  default, "Minimal" as a plain alternate, not just light/dark); autosave
  interval for snapshots; guardrail-modal notification behavior (a pending
  confirmation shouldn't be easy to miss while focused elsewhere);
  keybindings aligned to VS Code conventions where reasonable.

## Current repo state

The CLI + server bootstrap is built and verified working (installs,
builds, runs, serves a placeholder page with the vine motif, has a working
`/api/health` endpoint, validates the `--port` flag). Files present:

```
package.json        bin entry "mendophyte" -> dist/cli.js
tsconfig.json        ES2022 / NodeNext
src/cli.ts            arg parsing (commander), starts server, opens browser
src/server/index.ts   express static server + health check (deliberately
                        thin — this is where orchestration attaches next)
public/index.html      placeholder landing page (vine SVG, serif wordmark)
README.md
.gitignore
```

Verified: `npm install && npm run build && npm start` starts on port 4317,
opens the browser, `/api/health` returns `{status:"ok", ...}`, invalid
ports fail cleanly instead of crashing.

## Immediate next task

Build the **Agent SDK orchestration layer** on top of this bootstrap:

1. Wire a `query()` session in streaming input mode inside
   `src/server/`, with `appendSystemPrompt` seeded from `00-entry.md`'s
   three persistent sections.
2. Implement the `canUseTool` callback / `PreToolUse` hook for the
   guardrail list above, with a pending-approval mechanism the frontend
   can eventually poll or subscribe to (a websocket event is probably
   simplest, matching the terminal bridge's transport).
3. Define an initial structured-output JSON Schema covering at minimum:
   current phase, phase-complete flag, and `your_turn_items` — resolve the
   open question above (schema-per-call vs. varies-per-phase) before
   locking this in.
4. Keep this layer testable independent of any frontend — a CLI script
   or a couple of integration tests hitting a real (or logged) Claude
   Code session is more useful right now than wiring it to panels that
   don't exist yet.

## How to work with me on this

- I read outputs critically and expect strict fidelity to what we've
  actually decided above — flag it plainly rather than quietly smoothing
  over a gap if something here is ambiguous or you think it should change.
- I want to debug precisely and iteratively — small verifiable steps over
  a big speculative leap.
- I'd rather you use tokens/effort purposefully than liberally — don't
  pad, don't re-explain settled decisions back to me, don't build ahead of
  what was actually asked for in a given step.
