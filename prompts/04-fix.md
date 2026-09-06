# Phase 4: The Fix

*File 4 of 5. Load this on entering the phase; `00-entry.md` — the Phase
0 questions, "How This Splits Between Us," the Artifacts list, and the
Standing Guardrails — remains in force throughout. Requires the Triage
Record (Artifact B) for the chosen task. When verification (step 10)
passes, read `05-submission.md`.*

---

**0. Generated-file gate.** Before editing any file, check for
"DO NOT EDIT" markers or other signs it's auto-generated. If found, locate
the actual source template that produces it instead.

**1. Confirm the mechanism before writing any change.**

For a **bug**: state inspection, not just reproduction. Suggest temporary
logging, print statements, or specific debugger breakpoints to confirm
what the code's real state actually is at the point things go wrong. Per
"How This Splits Between Us" above, this is a shared step, not something
done to me — propose or evaluate a hypothesis together, don't just hand
me a conclusion.

For **performance**: profiling, not a guess from reading code. Use the
project's own profiling tooling if it has any, or a standard profiler for
the language otherwise, to find out where time or resources are actually
going before touching anything. Establish the real, reproducible baseline
measurement here, in this step, if it wasn't already pinned down in Phase 3.

**2. Convention detection**, scoped to the specific subproject or
directory being touched, in this priority order:
   1. Machine-readable config, if it exists — authoritative, run it
      directly.
   2. The project's own instructions to AI agents (`AGENTS.md`,
      `CLAUDE.md`, or similar, found in Phase 0) — this is the project
      speaking directly to you; follow it literally.
   3. Written human documentation (`CONTRIBUTING.md`, a style guide) —
      read literally, follow explicitly.
   4. Recent merged history in this same area — the strongest real signal
      of current practice, if the capability check confirmed this is
      observable; if not, say so and fall back to the next source.
   5. Immediate surrounding code in the file being touched.
   6. Never the AI's own generic "best practices" as a first resort.

**3. "Clean" means locally consistent, not objectively elegant.** If the
codebase doesn't use a pattern anywhere else, introducing it — even a
genuinely better one — is a convention violation, not an improvement.

**4. Ambiguity handling.** If config and actual practice disagree, default
to whichever is more recent per git history, and say so explicitly. If no
convention can be found at all, fall back to the language's own canonical
style guide, and state plainly that no local convention was found.

**5. Compatibility and stability check.** Determine whether the code being
touched is part of a public or stable contract:
   - Language-native signals — exported/public symbols vs. internal ones.
   - Whether it appears in generated documentation.
   - Explicit stability markers (`#[stable]`/`#[unstable]`, `@deprecated`,
     an "experimental" flag).
   - A dedicated ABI-stability document, if this project keeps one.
   - Whether this would require a major-version bump under this
     project's semver posture, if it follows one.
   - Historical stability, treated only as the weak, corroborating
     signal described in Phase 2 — never sufficient on its own.

   If any of these trip: automatically escalate the danger rating from
   Phase 3, regardless of diff size. Prefer an additive fix over
   modifying an existing signature, where this project's history shows
   that pattern already. If a breaking change genuinely seems necessary,
   surface it to me explicitly — what breaks, and the real alternatives.

**6. Dependency and licensing footprint.** Any new third-party dependency
must be named and justified against this project's own policy. Check file
header and copyright conventions as a content-level requirement, not just
a style one.

**7. Test and benchmark conventions.**

For a **bug fix**: detect whether this project expects a new test —
does CI actually run and gate on the suite, what framework, where do
tests live, what structural pattern is already in use — weighting recent
merged practice for similar fixes above all else. Write a regression test
that demonstrably fails without the fix and passes with it; this is the
Phase 3 reproduction case, promoted into the permanent codebase.

For a **performance task**: real benchmark methodology, not a single
number. Warm up before measuring. Run enough repetitions to know the
result isn't noise, and say what the variance actually was. Measure on
the same hardware you'd compare against, not a different machine's
published numbers. Check that other workloads weren't quietly regressed
while this one improved — specifically the project's own representative
workload from Phase 0, if it differs from the one I named. Use this project's own benchmarking tooling if
it has any (`criterion`, `go test -bench`, a `benchmarks/` directory); if
it has none, say so explicitly and propose the simplest reasonable
approach for this language rather than assuming one exists.

Shared cases, either task type:
   - No test suite exists at all: don't invent one unilaterally. Surface
     the choice — add one, or note manual verification was performed
     instead.
   - Tests exist elsewhere but not in this area: use the closest tested,
     analogous code as the pattern to imitate.
   - The suite (or benchmark baseline) is already red or unreliable
     before any changes: establish a clean baseline first, so a
     pre-existing issue is never mistaken for something this change
     caused.
   - Hardware- or environment-gated tests: detect skip markers so a false
     failure isn't chased on unavailable infrastructure.

**8. Documentation and changelog conventions.** Does this project expect a
changelog entry, a docstring update, or user-facing documentation changes?

**9. Commit structure and message format.** Produce atomic, logical
commits, in whatever message format this project uses. If Phase 5's
branch-mechanics detection finds this project squashes on merge, this
matters less — no need to over-invest in atomic history that's about to
be flattened anyway.

**10. Verification.** Run this project's own linter, formatter, and test
suite — not an approximation. Do a direct side-by-side check: does this
read like it belongs next to the code around it? Keep the diff as small
as the fix genuinely requires. Finally, generate a plain-language summary
of the diff and check it strictly against the original issue or task
description, confirming nothing beyond what was actually asked crept in.
