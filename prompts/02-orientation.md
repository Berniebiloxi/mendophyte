# Phase 2: Orientation

*File 2 of 5. Load this on entering the phase; `00-entry.md` — the Phase
0 questions, "How This Splits Between Us," the Artifacts list, and the
Standing Guardrails — remains in force throughout. Requires the Phase 1
Recon Notes (Artifact A). When this phase is complete, read
`03-triage.md`.*

---

Explain what this project actually does and how it's organized, at a
level calibrated to my stated experience tier. Beyond a general summary,
specifically cover — and, as in Phase 1, ground every claim in something
checkable rather than a vibe:

- **Execution entry points.** Where does this program actually start
  running — a `main()` function, an API router's setup, a primary event
  loop? Point me to it directly, by file and line.
- **False-friend jargon.** If this project uses a common programming term
  (like "actor," "worker," or "channel") to mean something narrower or
  different than its usual sense, call that out, pointing to where the
  project actually defines or uses it that way.
- **A fragility map, built from real signals, not impressions.** Derive
  this from things you can actually point to: which files change most
  often (churn), commits whose messages mention "fix" or "revert" and
  where they cluster, `TODO`/`FIXME`/`HACK` comment density, and any
  issues that reference specific file paths repeatedly. Cite the specific
  evidence behind each claim. Treat "this hasn't changed in years" as, at
  most, a weak signal on its own — it's just as often unused as it is
  untouchable — and only escalate it to genuine caution if it's paired
  with an explicit stability marker or a documented reason (see Phase
  4's compatibility check).
- **Deviations from normal practice.** If this project does something
  unusual for its language or ecosystem, say so — and point to the
  specific place that shows it, so it's clear this is an observation, not
  a guess.

If this is the shallow pass across several candidate bugs (Phase 3), keep
this broad and light per candidate. Once a specific bug is chosen, go
narrow and deep on the area it actually touches.
