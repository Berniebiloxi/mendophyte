import type { FileFragility, FragilityReport } from "./compute.js";

/**
 * Renders the fragility report as evidence the agent can cite in Phase 2.
 * Raw counts with their sources; the `heat` blend is deliberately absent.
 */
export function formatFragilityFacts(r: FragilityReport, limit = 12): string {
  const L: string[] = [];
  const scope = r.subpath ? `subpath \`${r.subpath}\`` : "the whole repository";
  L.push(`## Phase 2 fragility-map inputs, computed by Mendophyte at ${r.ranAt} for ${scope}`);
  L.push("");
  if (r.error) {
    L.push(`- UNOBSERVED: ${r.error}`);
    return L.join("\n");
  }
  const w = r.window;
  L.push(
    `Sources: ${r.sources.map((s) => `\`${s}\``).join("; ")}. Window: ${w.commitsScanned} non-merge commits${w.oldest ? ` from ${w.oldest} to ${w.newest}` : ""}${w.truncated ? ` (capped at ${w.maxCommits}; older history not scanned)` : ""}; ${r.trackedFiles} tracked files in scope.`
  );
  L.push(
    "These are signals, not verdicts. Cite them by source and count (for example \"12 fix commits of 30 since 2024-01, git log\"), pair them with what the code itself shows, and remember 02-orientation.md's rule: an untouched file is a weak signal on its own."
  );
  L.push("");

  const fileLine = (f: FileFragility, focus: "churn" | "fixes" | "markers") => {
    const parts: string[] = [];
    if (focus === "churn") parts.push(`${f.commits} commits, +${f.added}/-${f.deleted}`);
    if (focus === "fixes") {
      const pct = f.commits ? Math.round((f.fixCommits / f.commits) * 100) : 0;
      parts.push(`${f.fixCommits} fix/revert commits of ${f.commits} (${pct}%)${f.revertCommits ? `, ${f.revertCommits} revert(s)` : ""}`);
    }
    if (focus === "markers") {
      const kinds = (Object.entries(f.markers) as [string, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ");
      parts.push(`${f.markerTotal} marker(s) [${kinds}]${f.lines ? ` in ${f.lines} lines (${f.markersPerKloc} per kLOC)` : ""}`);
    }
    if (focus !== "churn" && f.commits) parts.push(`${f.commits} commits`);
    if (focus !== "fixes" && f.fixCommits) parts.push(`${f.fixCommits} fix commits`);
    if (focus !== "markers" && f.markerTotal) parts.push(`${f.markerTotal} TODO-class markers`);
    if (f.lastTouched) parts.push(`last touched ${f.lastTouched}`);
    return `- \`${f.path}\`: ${parts.join("; ")}`;
  };

  L.push("### Churn: most frequently changed files");
  if (!r.top.churn.length) L.push("- no commits in the window touch tracked files in scope");
  for (const f of r.top.churn.slice(0, limit)) L.push(fileLine(f, "churn"));
  if (r.directories.length) {
    L.push(`- by directory (a commit counts once per directory): ${r.directories.slice(0, 8).map((d) => `\`${d.path}\` ${d.commits}`).join(", ")}`);
  }
  L.push("");

  L.push("### Fix / revert clustering");
  const pct = w.commitsScanned ? Math.round((w.fixCommits / w.commitsScanned) * 100) : 0;
  L.push(`- ${w.fixCommits} of ${w.commitsScanned} commits have a fix-like subject (${pct}%); ${w.revertCommits} are reverts. Subject match: fix/fixes/fixed/bugfix/hotfix/regression/revert.`);
  if (r.fixClusters.length) {
    L.push(`- where they cluster, by directory: ${r.fixClusters.slice(0, 8).map((d) => `\`${d.path}\` ${d.fixCommits} fix commits across ${d.files} files`).join("; ")}`);
  }
  if (!r.top.fixes.length) L.push("- no file in scope was touched by a fix-like commit in the window");
  for (const f of r.top.fixes.slice(0, limit)) {
    L.push(fileLine(f, "fixes"));
    for (const c of f.fixExamples) L.push(`    - ${c.short} ${c.date} "${c.subject}"`);
  }
  L.push("");

  L.push("### TODO / FIXME / HACK / XXX density");
  const mt = r.markerTotals;
  L.push(`- totals: TODO ${mt.TODO}, FIXME ${mt.FIXME}, HACK ${mt.HACK}, XXX ${mt.XXX} across ${r.markerFiles} files`);
  if (!r.top.markers.length) L.push("- no markers found in tracked files in scope");
  for (const f of r.top.markers.slice(0, limit)) L.push(fileLine(f, "markers"));
  L.push("");

  L.push("### Weak signal: files with no commits in the window");
  L.push(`- ${r.stale.count} of ${r.trackedFiles} tracked files have no commit since the window start${r.stale.byTopDir.length ? `; concentrated in ${r.stale.byTopDir.map(([d, n]) => `\`${d}\` ${n}`).join(", ")}` : ""}.`);
  L.push("- Per 02-orientation.md, \"hasn't changed in years\" is as often unused as untouchable. Escalate only with an explicit stability marker or documented reason (Phase 4's compatibility check).");

  return L.join("\n");
}
