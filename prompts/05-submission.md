# Phase 5: Submission

*File 5 of 5. Load this on entering the phase; `00-entry.md` — the Phase
0 questions, "How This Splits Between Us," the Artifacts list, and the
Standing Guardrails — remains in force throughout. Requires Artifacts
A–C. Sections F and G apply on a later resume, not in the session that
opens the PR.*

---

**A. Channel and posture detection.**
   - Determine the actual submission mechanism — GitHub/GitLab PR, a
     Gerrit/Phabricator review system, or a mailing-list workflow — per
     subsystem, since this can differ within one repository.
   - Check whether this GitHub repository is actually a read-only mirror
     of a project hosted elsewhere.
   - Check whether this project expects a discussion or agreed direction
     before a PR for anything beyond a trivial fix, and honestly assess
     whether this fix has quietly grown past "trivial."
   - Read the overall formality posture as a spectrum — this scales the
     tone and rigor of everything below.

**B. Legal and procedural gates.**
   - Detect DCO (`Signed-off-by:` via `git commit -s`) versus a separate
     CLA. Never fabricate a sign-off without it genuinely reflecting my
     intent. (The employer-IP question itself was already asked once, in
     Phase 0 — this step is about detecting which mechanism this project
     actually uses, not re-litigating that question.)
   - Detect other trailers this project's history actually uses
     (`Reported-by`, `Reviewed-by`, `Tested-by`) and apply them where
     appropriate.
   - If `SECURITY.md` (found in Phase 1) indicates this area should be
     privately disclosed rather than submitted as a public PR, follow
     that process instead.

**C. Branch and history mechanics.**
   - Fork-and-branch versus a direct branch, based on my actual
     permissions on this repository.
   - This project's branch naming convention, if one exists.
   - Infer squash-vs-rebase-vs-preserved-history expectations from the
     actual shape of recent merged PRs, if observable per the Phase 0
     capability check; if not observable, ask me or default to the more
     conservative option (preserve history, don't force-push) until told
     otherwise.
   - Infer force-push norms after review begins the same way — and note
     that even where a project expects fixup-and-force-push, this always
     requires my explicit go-ahead each time, per the standing
     guardrails.
   - Confirm the correct target branch — not everything targets `main`.

**D. The submission artifact.**
   - Match this project's title format.
   - Follow the PR template exactly if one exists.
   - Carry the Phase 3 triage reasoning into the description — why this
     is safe, what the reproduction or baseline was, what was verified.
     Who drafts this is set by "How This Splits Between Us."
   - If Phase 0 found that this project requires disclosure of
     AI-assisted work, include it, in whatever form the project asks for.
   - Check for a required changelog-fragment file.
   - Include a before/after screenshot or recording if norms call for one.
   - If the diff stayed large despite Phase 4's minimal-diff discipline,
     consider whether this project's culture expects a split into
     multiple focused PRs.
   - Match this project's posture on draft-first versus fully polished.

**E. Final pre-submission gate.**
   - Run whatever CI will run, exactly as CI runs it, including matching
     any pinned toolchain version rather than whatever's active locally.
   - Confirm the fork or branch is synced to upstream's current state
     right before opening.
   - If this project's CI has a known flaky pattern, run checks locally
     more than once before trusting a single clean pass.
   - Confirm sign-off and any required status checks are actually
     satisfied, not just assumed to be.

**F. Post-submission conduct.** Everything in F and G happens after the
session that produced the PR is over — you aren't watching the thread.
These apply on resume, when I bring the review back to you and Phase 0's
resume check has read Artifacts A–F and diffed them against the PR's
current state.
   - Check `CODEOWNERS` to understand who's actually likely to review.
   - Check whether this project's CI requires a maintainer-issued comment
     command (`/ok-to-test`, `/retest`) before it runs on a first-time
     contributor's PR.
   - If maintainers visibly disagree with each other in the thread,
     surface that to me and ask how I want to navigate it.
   - If CI turns red after submission, check whether an unrelated change
     landed on the target branch before assuming this fix caused it.
   - When review feedback arrives, explain it to me in plain language
     first — this is a learning opportunity, not just something to
     auto-apply.
   - Respond to feedback using whatever mechanism section C detected,
     with my explicit go-ahead each time before force-pushing anything.

**G. Escalation and failure handling.**
   - If a maintainer requests a fundamentally different approach, route
     back to Phase 3 or 4 for that new approach.
   - Define "stale" relative to this specific project's actual pace. The
     honest default is patience or a single polite check-in.
   - Treat outright rejection as a real, legitimate outcome — wrong
     approach (revise and resubmit), not actually a bug (a valid outcome
     to learn from), or the area being deprecated (nothing further to
     pursue here).

**H. The per-project feedback log.** Maintain a private, local log of
durable lessons from real feedback — the lesson, not a transcript. It
lives in the artifact home chosen in Phase 0, step 0 — outside the
target repository, alongside Artifacts A–E — and is read as part of every
resume check. Weight it above general recent-merged-history as a
convention signal, since it's specifically targeted. If it conflicts with
what live recon currently finds, the live signal wins, and the old entry
gets flagged as possibly stale.
