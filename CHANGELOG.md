# Changelog

Versions follow semver while pre-1.0: the minor number moves with each
batch of user-visible changes, the patch number with fixes only. The
number lives in package.json and is read from there everywhere
(health endpoint, SDK client string, MCP server, About box).

## 0.6.0 — 2026-09-07

- Bundled fonts (Inter, Source Serif 4, JetBrains Mono; Latin subsets,
  ~150 KB total) so the app looks the same on every platform. Used by
  default on Windows, where Segoe UI / Palatino Linotype / Consolas read
  very differently; View → Appearance → Fonts chooses auto, system or
  bundled anywhere. The terminal refits once fonts load.

## 0.5.0 — 2026-09-07

- File → Quit Mendophyte stops the server and frees the port; the page
  shows that it stopped and stops reconnecting.
- One origin: page loads on 127.0.0.1 are redirected to localhost. The
  browser keeps layout, theme, UI size and its own zoom per site, so the
  two names looked like two differently-sized apps.
- Session snapshots are listed in the Artifacts panel and open there.
- UI size menu says when the browser's own zoom is on for this site.

## 0.4.1 — 2026-09-07

- Project rows wrap in a narrow tile so the name keeps its space and
  the actions drop to a second line.
- The prior-projects list could collapse to nothing in a short Session
  tile (a scrolling flex child with min-height 0). It keeps its height.

## 0.4.0 — 2026-09-07

- Session panel: prior projects sit above the new-session form, which
  collapses once a session exists, so the list is not buried.
- Turn timing splits out time spent waiting on the user (question cards,
  confirmations) so wall-clock is not mistaken for agent slowness.
- Native confirm/prompt dialogs are logged with their duration; the
  "main thread blocked" lines they cause now have an explanation next
  to them. End session is disabled once a session has ended and gives
  feedback; a terminal closed by the server no longer tries to
  reconnect. The SDK's pre-approved-tools warning is logged as an
  expected note, not an error.

## 0.3.0 — 2026-09-07

- The agent's replies are rendered as Markdown in the conversation: each
  heading becomes a titled box, tables become tables, code fences become
  code, lists and emphasis render. Plain replies stay plain. Question
  cards and your-turn prompts render inline formatting (bold, code,
  links). All of it passes through the same sanitizer as artifacts.

## 0.2.0 — 2026-09-06

The first day of real use on langchain and seatsniper, and everything it
taught us.

- AskUserQuestion routed to the UI as option cards; batched your-turn
  answers; guardrails on every forge write, not only PR creation;
  `git stash push` no longer mistaken for a push.
- Debug log: one Markdown file per run with requests, socket frames,
  session events, approvals, questions, browser actions and errors;
  Help → Debug log panel with pause/resume, marker and download; CLI
  output mirrored in.
- Streaming replies, a working indicator, per-turn wall/API timing
  (Claude Code's totals are cumulative; per-turn is the difference),
  live phase inferred from the agent opening the phase prompts.
- Child processes get a cleaned environment (npm_* stripped, user tool
  dirs on PATH); pre-flight reports the git identity; terminal reconnects
  and reports dropped keystrokes; interrupt gives feedback and is
  disabled when idle.
- Clay bento styling in rem with a global UI size (auto by screen),
  menubar above the tiles with hover switching and flyouts, no
  split-view lines, question cards, animated progress tree with labels
  clear of connectors, approval modal that fits the viewport.
- Snapshots (save to the artifact home / export), prior-project rename,
  move, delete and Locate, Open project… with clone-path recovery,
  workflow layout presets, follow-the-phase, saved layout management.
- Store selectors and an event index so panels stop re-rendering on
  every agent event.

## 0.1.0 — 2026-09-05

First complete build of the handoff: orchestration layer over the Claude
Agent SDK (streaming, appended system prompt, guardrails with a pending
approval broker, structured dashboard state), deterministic Phase 0
pre-flight, fragility map, verification runner, submission tracker,
feedback log, benchmark panel, local server with REST and websockets,
dockable web UI, terminal, CI on Linux, macOS and Windows.
