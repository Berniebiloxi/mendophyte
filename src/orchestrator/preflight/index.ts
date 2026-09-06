import { checkCapability, type CapabilityReport } from "./capability.js";
import { parseRemoteUrl, type ForgeInfo } from "./forge.js";
import { assessHealth, type RepoHealth } from "./health.js";
import {
  listArtifactHome,
  readEnvironment,
  readGitState,
  readScale,
  type ArtifactEntry,
  type EnvironmentReport,
  type GitState,
  type ScaleReport,
} from "./local.js";
import { scanPolicyFiles, type PolicyReport } from "./policy.js";
import { run } from "./run.js";
import { readFeedbackLog, type FeedbackLog } from "../feedback-log.js";

export interface PreflightReport {
  ranAt: string;
  repoDir: string;
  artifactHome: string;
  capability: CapabilityReport;
  health: RepoHealth;
  policy: PolicyReport;
  artifacts: { exists: boolean; entries: ArtifactEntry[] };
  feedbackLog: FeedbackLog;
  git: GitState;
  scale: ScaleReport;
  environment: EnvironmentReport;
}

export interface PreflightOptions {
  repoDir: string;
  artifactHome: string;
  /** Override forge detection (e.g. no origin remote yet but the user gave a URL). */
  repoUrl?: string;
}

/** Reads the origin URL, or null when there is none. */
export async function detectForge(repoDir: string, repoUrl?: string): Promise<ForgeInfo | null> {
  if (repoUrl) {
    const f = parseRemoteUrl(repoUrl);
    if (f) return f;
  }
  const r = await run("git", ["remote", "get-url", "origin"], { cwd: repoDir, timeoutMs: 10_000 });
  if (!r.ok) return null;
  return parseRemoteUrl(r.stdout.trim());
}

/**
 * Runs every deterministic Phase 0 check. Never throws for a probe
 * failure: failures become UNOBSERVED lines. Network probes run in
 * parallel with the local scans; worst case is one probe timeout (20s).
 */
export async function runPreflight(opts: PreflightOptions): Promise<PreflightReport> {
  const ranAt = new Date().toISOString();
  const forge = await detectForge(opts.repoDir, opts.repoUrl);

  const [capability, policy, artifacts, feedbackLog, git, scale, environment] = await Promise.all([
    checkCapability(opts.repoDir, forge),
    scanPolicyFiles(opts.repoDir),
    listArtifactHome(opts.artifactHome),
    readFeedbackLog(opts.artifactHome),
    readGitState(opts.repoDir),
    readScale(opts.repoDir),
    readEnvironment(),
  ]);

  const health = assessHealth(forge, capability.anonymousApi);

  return {
    ranAt,
    repoDir: opts.repoDir,
    artifactHome: opts.artifactHome,
    capability,
    health,
    policy,
    artifacts,
    feedbackLog,
    git,
    scale,
    environment,
  };
}

export { formatPreflightFacts } from "./format.js";
export { parseRemoteUrl, type ForgeInfo, type ForgeKind } from "./forge.js";
export { findHits, scanPolicyFiles, type PolicyFile, type PolicyHit, type PolicyReport } from "./policy.js";
export type { CapabilityReport, CapabilityTier } from "./capability.js";
export type { RepoHealth } from "./health.js";
export type { ArtifactEntry, EnvironmentReport, GitState, ScaleReport } from "./local.js";
