import type { PreflightReport } from "./index.js";
import type { PolicyFile } from "./policy.js";
import { formatFeedbackFacts } from "../feedback-log.js";

/**
 * Renders the report as the "facts" block for the kickoff message.
 *
 * Wording rules, because the meta-prompt's guardrail on forge-derived
 * facts depends on them: every line is either OBSERVED with its source,
 * or UNOBSERVED with the reason. Nothing here interprets policy text.
 */

const yesNo = (v: boolean | null) => (v === null ? "unobserved" : v ? "yes" : "no");

function fmtHits(f: PolicyFile): string[] {
  const out: string[] = [];
  const kb = Math.max(1, Math.round(f.bytes / 1024));
  const trunc = f.truncated ? ", scanned first 256 KB only" : "";
  out.push(`- \`${f.path}\` (${f.role}, ${kb} KB${trunc}): ${f.aiHits.length} AI-related line(s), ${f.legalHits.length} CLA/DCO-related line(s)`);
  for (const h of f.aiHits) out.push(`    - AI · L${h.line}: ${h.text}`);
  for (const h of f.legalHits) out.push(`    - legal · L${h.line}: ${h.text}`);
  return out;
}

export function formatPreflightFacts(r: PreflightReport): string {
  const L: string[] = [];
  const cap = r.capability;
  const health = r.health;

  L.push(`## Phase 0 pre-flight, run by Mendophyte at ${r.ranAt}`);
  L.push("");
  L.push(
    "Each line below is OBSERVED (with the command or URL it came from) or UNOBSERVED (with the reason). Treat OBSERVED items as already verified and cite the source; do not re-run them unless something has changed. Never fill an UNOBSERVED item by inference; ask me or label it."
  );
  L.push("");

  // Step 3
  L.push("### Step 3, capability check");
  if (cap.forge) {
    L.push(`- OBSERVED (\`git remote get-url origin\`): forge ${cap.forge.kind} at ${cap.forge.host}, project \`${cap.forge.path}\`, web URL ${cap.forge.webUrl}`);
  } else {
    L.push("- OBSERVED (`git remote get-url origin`): no origin remote");
  }
  const probe = (label: string, p: { source: string; ok: boolean; summary: string; skipped?: boolean }) =>
    p.skipped
      ? `- ${label}: UNOBSERVED, ${p.summary}`
      : `- ${label} (\`${p.source}\`): ${p.ok ? "OK" : "FAILED"}, ${p.summary}`;
  L.push(probe("authenticated forge CLI", cap.authCli));
  L.push(probe("git ls-remote", cap.lsRemote));
  L.push(probe("anonymous forge API", cap.anonymousApi));
  const tierLabel = { full: "full forge access", partial: "partial access", "local-only": "local clone only" }[cap.tier];
  L.push(`- **Capability tier: ${tierLabel}**`);
  for (const n of cap.notes) L.push(`  - ${n}`);
  L.push("");

  // Step 4
  L.push("### Step 4, repo health");
  if (health.observed) {
    L.push(`- OBSERVED (\`${health.source}\`): exists ${yesNo(health.exists)}; public ${yesNo(health.public)}; archived ${yesNo(health.archived)}; disabled ${yesNo(health.disabled)}; read-only mirror ${yesNo(health.mirror)}`);
    if (health.reason) L.push(`  - note: ${health.reason}`);
    const extras: string[] = [];
    if (health.defaultBranch) extras.push(`default branch ${health.defaultBranch}`);
    if (health.fork !== null) extras.push(health.fork ? `fork of ${health.forkOf ?? "unknown"}` : "not a fork");
    if (health.issuesEnabled !== null) extras.push(`issues ${health.issuesEnabled ? "enabled" : "disabled"}`);
    if (health.openIssues !== null) extras.push(`${health.openIssues} open issues (forge count; may include PRs)`);
    if (health.stars !== null) extras.push(`${health.stars} stars`);
    if (health.lastActivity) extras.push(`last activity ${health.lastActivity}`);
    if (extras.length) L.push(`- OBSERVED (same request): ${extras.join("; ")}`);
  } else {
    L.push(`- UNOBSERVED: ${health.reason ?? "no forge data"}. Existence, visibility and archived status must be confirmed by me; "archived" is a forge property, not a git one.`);
  }
  L.push("");

  // Step 5 / 8
  L.push("### Steps 5 and 8, AI-contribution stance and legal gates (files found and lines flagged)");
  if (r.policy.files.length === 0) {
    L.push("- OBSERVED: none of the candidate files exist.");
  } else {
    for (const f of r.policy.files) L.push(...fmtHits(f));
  }
  const roles = new Set(r.policy.files.map((f) => f.role));
  const absent: string[] = [];
  if (!roles.has("contributing")) absent.push("CONTRIBUTING file");
  if (!roles.has("pr-template")) absent.push("PR/MR template");
  if (!roles.has("agent-instructions")) absent.push("agent-instruction file (AGENTS.md, CLAUDE.md, .cursorrules, copilot-instructions, ...)");
  if (!roles.has("legal")) absent.push("standalone CLA/DCO file");
  if (!roles.has("workflow")) absent.push("CLA/DCO-related workflow");
  if (absent.length) L.push(`- OBSERVED absent: ${absent.join("; ")}`);
  L.push(`- Checked locations (case-insensitive): ${r.policy.checked.join(", ")}`);
  L.push(
    "- Mendophyte only found these lines. Deciding whether they amount to a ban, a disclosure requirement, a CLA/DCO requirement, or nothing at all is your reading to make, citing the file and line. If a file exists but has no flagged lines, read it anyway before concluding the project is silent."
  );
  L.push("");

  // Step 0
  L.push("### Step 0, artifact home");
  L.push(`- Location: ${r.artifactHome}`);
  if (!r.artifacts.exists) L.push("- OBSERVED: the directory does not exist yet (first session for this repository).");
  else if (r.artifacts.entries.length === 0) L.push("- OBSERVED: the directory exists and is empty (first session for this repository).");
  else {
    L.push("- OBSERVED contents (read these before doing anything else, per step 0):");
    for (const e of r.artifacts.entries) L.push(`  - ${e.name}${e.isDir ? "/" : ""} (${e.bytes} bytes, modified ${e.modified})`);
  }
  L.push("");
  L.push("### Artifact F, the per-project feedback log (05-submission.md section H)");
  L.push(...formatFeedbackFacts(r.feedbackLog));
  L.push("");

  // Local repo state
  const g = r.git;
  L.push("### Local repository state");
  if (!g.isRepo) L.push(`- OBSERVED: ${r.repoDir} is not a git repository.`);
  else {
    L.push(`- OBSERVED (git): branch ${g.branch ?? "unknown"} at ${g.head ?? "?"}; upstream ${g.upstream ?? "none"}${g.ahead !== null ? `; ahead ${g.ahead}, behind ${g.behind}` : ""}; ${g.dirtyFiles === null ? "dirty state unknown" : g.dirtyFiles === 0 ? "working tree clean" : `${g.dirtyFiles} modified/untracked path(s)`}`);
    if (g.remotes.length) L.push(`- OBSERVED remotes: ${g.remotes.map((x) => `${x.name} = ${x.url}`).join("; ")}`);
  }
  L.push("");

  // Step 9
  L.push("### Step 9, scale (rough, from `git ls-files`)");
  if (r.scale.trackedFiles === null) L.push("- UNOBSERVED: git ls-files failed.");
  else {
    L.push(`- OBSERVED: ${r.scale.trackedFiles} tracked files`);
    if (r.scale.topExtensions.length) L.push(`- by extension: ${r.scale.topExtensions.map(([e, n]) => `${e} ${n}`).join(", ")}`);
    if (r.scale.topDirectories.length) L.push(`- by top-level directory: ${r.scale.topDirectories.map(([d, n]) => `${d} ${n}`).join(", ")}`);
    L.push("- Line counts and density are not computed; form the gut-check from this plus what you see.");
  }
  L.push("");

  // Step 10
  const e = r.environment;
  L.push("### Step 10, the machine Mendophyte is running on");
  L.push(
    `- OBSERVED: ${e.platform} ${e.release} (${e.arch}), ${e.cpuCount} CPU${e.cpuCount === 1 ? "" : "s"}${e.cpuModel ? ` (${e.cpuModel})` : ""}, ${e.totalMemGb} GB RAM, node ${e.node}${r.git.gitVersion ? `, git ${r.git.gitVersion}` : ""}${e.wsl ? ", inside WSL" : ""}${e.container ? ", inside a container" : ""}`
  );
  L.push("- This is where the agent runs. Still ask me what hardware and environment I actually test against; they may differ.");

  return L.join("\n");
}
