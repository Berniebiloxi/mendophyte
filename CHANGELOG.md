# Changelog

Versions follow semver while pre-1.0: the minor number moves with each
batch of user-visible changes, the patch number with fixes only. The
number lives in package.json and is read from there everywhere
(health endpoint, SDK client string, MCP server, About box).

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
