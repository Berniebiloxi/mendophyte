import type { DetectionReport } from "./detect.js";
import type { VerificationRun } from "./run.js";

export function formatDetection(d: DetectionReport): string {
  const L: string[] = [];
  const scope = d.subpath ? `subpath \`${d.subpath}\`` : "the repository root";
  L.push(`## Verification commands detected by Mendophyte for ${scope}`);
  L.push("");
  L.push(`Manifests found: ${d.manifests.length ? d.manifests.map((m) => `\`${m}\``).join(", ") : "none"}.`);
  L.push("These are candidates read from machine-readable config (top of Phase 4's convention hierarchy). Confirm against CONTRIBUTING and CI before trusting the set, and add anything the project documents that isn't listed. Nothing below has been run.");
  L.push("");
  if (d.checks.length) {
    L.push("### Candidate checks");
    for (const c of d.checks) {
      const flags = [c.mayModify ? "modifies files" : null, c.heavy ? "heavy, not in the default set" : null, c.successRule === "no-output" ? "passes only on empty output" : null].filter(Boolean);
      L.push(`- \`${c.id}\` (${c.kind}): \`${c.command}\`${c.cwd ? ` in ${c.cwd}` : ""}; source: ${c.source}${flags.length ? `; ${flags.join("; ")}` : ""}`);
    }
    L.push("");
    L.push("Default set for `run_verification` with `use_detected: true`: kinds format, lint, typecheck, test; excludes anything that modifies files or is heavy.");
    L.push("");
  } else {
    L.push("### Candidate checks");
    L.push("- none detected");
    L.push("");
  }
  L.push("### Toolchain pins (Phase 5E: match CI's toolchain, not whatever is active)");
  if (!d.toolchain.length) L.push("- no pins found (.nvmrc, .node-version, engines, rust-toolchain, go directive, requires-python, .python-version, .tool-versions)");
  for (const t of d.toolchain) L.push(`- ${t.tool}: pinned \`${t.pinned}\` (${t.source}); local ${t.local ? `\`${t.local}\`` : "not found"} (${t.localSource})`);
  L.push("");
  L.push("### What CI runs (literal `run:` / `script:` steps, in file order)");
  if (!d.ciSteps.length) L.push("- no workflow files found under .github/workflows or .gitlab-ci.yml");
  for (const s of d.ciSteps.slice(0, 60)) {
    const one = s.run.split("\n");
    L.push(`- ${s.file}: \`${one[0].slice(0, 160)}\`${one.length > 1 ? ` (+${one.length - 1} more line${one.length > 2 ? "s" : ""})` : ""}`);
  }
  if (d.ciSteps.length > 60) L.push(`- (${d.ciSteps.length - 60} more steps not shown)`);
  for (const n of d.notes) L.push(`- note: ${n}`);
  return L.join("\n");
}

const ICON: Record<string, string> = { passed: "PASS", failed: "FAIL", timeout: "TIMEOUT", refused: "REFUSED", error: "ERROR" };

export function formatRun(run: VerificationRun, tailLines = 40): string {
  const L: string[] = [];
  L.push(`## Verification run ${run.id.slice(0, 8)} by Mendophyte, ${run.ranAt}`);
  L.push("");
  const c = run.counts;
  L.push(`Result: ${run.allPassed ? "ALL PASSED" : "NOT ALL PASSED"}. ${c.passed} passed, ${c.failed} failed, ${c.timeout} timed out, ${c.refused} refused, ${c.error} errored, of ${run.results.length} checks.`);
  L.push("Only the checks listed below were run, and only a PASS line here counts as verified. Do not describe anything else as passing, verified, or green.");
  L.push("");
  for (const r of run.results) {
    const secs = (r.durationMs / 1000).toFixed(1);
    L.push(`- ${ICON[r.status]} \`${r.id}\` (${r.kind}): \`${r.command}\`${r.exitCode !== null ? `, exit ${r.exitCode}` : ""}${r.signal ? `, signal ${r.signal}` : ""}, ${secs}s${r.reason ? `; ${r.reason}` : ""}${r.logPath ? `; full log ${r.logPath}` : ""}`);
    if (r.status !== "passed" && r.status !== "refused" && r.outputTail.trim()) {
      const lines = r.outputTail.trimEnd().split(/\r?\n/);
      const shown = lines.slice(-tailLines);
      L.push("  ```");
      if (lines.length > shown.length) L.push(`  … (${lines.length - shown.length} earlier lines in the log)`);
      for (const l of shown) L.push(`  ${l}`);
      L.push("  ```");
    }
  }
  return L.join("\n");
}
