# Phase 3: Triage

*File 3 of 5. Load this on entering the phase; `00-entry.md` — the Phase
0 questions, "How This Splits Between Us," the Artifacts list, and the
Standing Guardrails — remains in force throughout. Requires Artifacts A
and the session-type answer from Phase 0. Once a task is chosen and
passes the deep pass, read `04-fix.md`.*

---

### If I asked you to find something (Phase 0, option 2): the shallow pass

This entire pass depends heavily on forge data. If the Phase 0 capability
check found no forge access, say so plainly here and offer the
alternative directly: ask me to paste in a few issue links or describe
what I'm seeing, rather than silently guessing at what the issue tracker
might contain.

**For a bug-fix session**, scan open issues and any stalled or abandoned
pull requests. Score each candidate against the following, named
explicitly so none of this is a black box:

- **Reproducibility signal** — does the issue already include clear repro
  steps, a minimal test case, or logs? Heavily weighted.
- **Staleness / already-claimed signal** — already assigned, already has
  an open PR, or already fixed on an unmerged branch? Deprioritize or
  exclude.
- **Discussion-complexity signal** — a long thread of maintainer
  disagreement about the right approach is a bad first pick regardless of
  how simple the code change looks.
- **Bisectability signal** — does the issue reference a specific version
  where this broke? Strong positive signal.
- **Environment/hardware fit** — checked against my Phase 0 answer.
- **Project health** — CI currently broken on the main branch is a
  caution flag for any first contribution.
- **Maintainer receptiveness** — has a maintainer already called this
  "wontfix" or expressed disinterest? Score separately from technical
  difficulty.
- **Root-cause location** — is this actually fixable within this
  repository, or does it live in a dependency or external infrastructure?
- **Determinism** — flag likely-flaky or timing-dependent bugs as a
  harder category, needing many runs and statistical confidence rather
  than a single clean reproduction.
- **Data/state dependencies** — does this bug only manifest with specific
  data, cache state, or permissions?
- **Label signal** — `good first issue`/`help wanted`/`bug` labels are a
  minor positive input, not the primary filter; many tractable bugs are
  never labeled, and mislabeling is common.

**For a performance session**, don't start from the issue tracker.
Performance work mostly isn't issue-driven: the honest shallow pass is to
profile the workload named in Phase 0 and see what's actually hot, then
treat the top of that profile as the candidate list. Cross-check against
open issues afterward, not instead. The criteria are genuinely different,
not a smaller version of the above:

- **Profiling signal** — is there already evidence of where time or
  resources actually go (an existing profile, a maintainer or issue
  explicitly pointing at a hot path), or would this candidate require
  profiling from scratch with no lead at all?
- **Baseline measurability** — can a reliable current-state measurement
  actually be taken with the hardware and environment from Phase 0? A
  claim that can't be measured can't be improved with any confidence.
- **Nondeterminism as the default, not an exception** — unlike a bug,
  variance between runs is expected here; this isn't a disqualifier, but
  it means the workflow needs real methodology (see Phase 4), not a
  single before/after number.
- **Regression-safety** — is there a way to confirm other workloads or
  correctness aren't harmed by a speed change, or would that require
  building the check from nothing?
- **Hardware criticality** — performance claims are disproportionately
  hardware-specific; weight the Phase 0 hardware answer heavily here.
- **Maintainer receptiveness to performance work specifically** — some
  projects reject micro-optimizations on readability grounds by default,
  or won't merge a speedup without a benchmark in CI. Closed and rejected
  perf PRs are the evidence, if the forge is reachable; if not, label
  this unobserved.

Present 3 to 5 ranked candidates either way, each with a one-line reason.
Tell me plainly what got filtered out and why. If nothing looks like a
safe, tractable starting point, say so honestly.

### Once a specific bug or task is chosen: the deep pass

Assess, and explain each clearly:

- **Root-cause location** — confirm the actual cause lives in this
  repository before going further.
- **Reproducibility** (bug) **or baseline** (performance) — can this be
  triggered, or measured, reliably, right now, before any code changes?
  If not, that's the actual first task.
- **Scope** — contained to one function, or does it ripple across
  subproject boundaries mapped in Phase 1?
- **Danger** — what's the blast radius if this is subtly wrong? A
  cosmetic bug and a bug in security- or safety-relevant code are not the
  same conversation, even at similar line-counts.
- **Doability, given where I actually am right now** — allowed to come
  back "no," with a specific reason and what would need to change.

### Task-level preflight

Can *this specific* task actually be verified with the hardware and
environment I have? If not, say so and steer back to the candidate list.

Also track **time-to-first-build** separately from the difficulty of the
fix itself. If just getting this project to compile and run locally is
taking a long time (a couple of hours is a reasonable default line) with
no clean success yet, flag this as its own potential bail-out — "the fix
is hard" and "I can't even get this running" are different problems.

### Time-box and honest bail-out

If a chosen task turns out to be substantially harder than triage
estimated, there should always be a clear, dignified way back to the
candidate list — framed as a real learning outcome, not a failure to push
through.
