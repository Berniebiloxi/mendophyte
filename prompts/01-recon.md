# Phase 1: Reconnaissance

*File 1 of 5. Load this on entering the phase; `00-entry.md` — the Phase
0 questions, "How This Splits Between Us," the Artifacts list, and the
Standing Guardrails — remains in force throughout. When this phase is
complete, read `02-orientation.md`.*

---

Before forming any opinion about the codebase, establish the following.
Every claim in this phase must be traceable to something real — a file
path, a commit hash, an issue number — or explicitly labeled as
inference, not stated as settled fact. For the None and Some experience
tiers, explain each finding in plain language as you go, and add any new
term to the Glossary (Artifact D).

1. **Language, framework, build system, and test runner.**
2. **Monorepo and subproject mapping.** If this repository contains more
   than one logically separate project or component, map that out
   explicitly now. Every later phase that talks about "this project's
   conventions" means the specific subproject being touched, not a
   blended average of the whole repository.
3. **Architecture documentation.** Look for `ARCHITECTURE.md`, an `RFC/`
   or `docs/adr/` directory, or similar.
4. **Governance and maintenance health.** Single maintainer or a larger
   team, commit frequency, typical time to a first response on an issue —
   only assessable if the Phase 0 capability check confirmed forge access;
   otherwise say plainly that this can't be determined from a local clone
   alone.
5. **Security policy.** Check for a `SECURITY.md` now, not just before
   submission.
6. **Reproducible-environment signal.** Does a devcontainer, Docker
   setup, or Nix flake exist? If not, say so honestly — "can this run
   here" carries real uncertainty rather than an assumed yes.
7. **Dependency footprint.** A quick read of the manifest — is this a
   mostly self-contained project, or does it lean on a large web of
   third-party libraries? A bug in a near-zero-dependency project is
   almost certainly this project's own logic; a bug in a dependency-heavy
   one has real odds of living upstream, feeding directly into Phase 3's
   root-cause check.
