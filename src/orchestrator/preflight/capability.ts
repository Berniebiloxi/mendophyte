import type { ForgeInfo } from "./forge.js";
import { failureReason, run } from "./run.js";

/**
 * Phase 0, step 3: "Capability check — probe, don't ask."
 *
 * Runs the three probes the meta-prompt names (authenticated CLI, git
 * ls-remote, anonymous API request) and classifies the tier. Each probe
 * records exactly what was run and what came back so the agent can cite
 * it, and so the capability dashboard can show it verbatim.
 */

export type CapabilityTier = "full" | "partial" | "local-only";

export interface ProbeOutcome {
  /** What was run or fetched, for citation. */
  source: string;
  ok: boolean;
  /** One-line human summary of the outcome. */
  summary: string;
  skipped?: boolean;
}

export interface ApiProbeOutcome extends ProbeOutcome {
  status: number | null;
  /** Parsed JSON body on 2xx; null otherwise. */
  body: Record<string, unknown> | null;
  rateLimitRemaining: number | null;
}

export interface CapabilityReport {
  forge: ForgeInfo | null;
  authCli: ProbeOutcome;
  lsRemote: ProbeOutcome & { refCount: number | null; headTarget: string | null };
  anonymousApi: ApiProbeOutcome;
  tier: CapabilityTier;
  /** Plain-language qualifiers the agent must carry forward (what is and isn't observable). */
  notes: string[];
}

export const PROBE_TIMEOUT_MS = 20_000;

async function probeAuthCli(forge: ForgeInfo | null): Promise<ProbeOutcome> {
  if (!forge) return { source: "(no forge)", ok: false, skipped: true, summary: "skipped: no forge remote detected" };

  if (forge.kind === "github") {
    const r = await run("gh", ["auth", "status", "--hostname", forge.host], { timeoutMs: PROBE_TIMEOUT_MS });
    const text = (r.stdout + "\n" + r.stderr).trim();
    const account = /Logged in to \S+ account (\S+)/.exec(text)?.[1];
    return r.ok
      ? { source: r.cmd, ok: true, summary: `authenticated${account ? ` as ${account}` : ""}` }
      : { source: r.cmd, ok: false, summary: failureReason(r) };
  }
  if (forge.kind === "gitlab") {
    const r = await run("glab", ["auth", "status", "--hostname", forge.host], { timeoutMs: PROBE_TIMEOUT_MS });
    const text = (r.stdout + "\n" + r.stderr).trim();
    const account = /Logged in to \S+ as (\S+)/.exec(text)?.[1];
    return r.ok
      ? { source: r.cmd, ok: true, summary: `authenticated${account ? ` as ${account}` : ""}` }
      : { source: r.cmd, ok: false, summary: failureReason(r) };
  }
  return {
    source: "(none)",
    ok: false,
    skipped: true,
    summary: `no authenticated CLI probe implemented for ${forge.kind} (${forge.host})`,
  };
}

async function probeLsRemote(repoDir: string): Promise<CapabilityReport["lsRemote"]> {
  const r = await run("git", ["ls-remote", "--symref", "origin"], {
    cwd: repoDir,
    timeoutMs: PROBE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (!r.ok) return { source: r.cmd, ok: false, summary: failureReason(r), refCount: null, headTarget: null };
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const head = lines.find((l) => l.startsWith("ref: "));
  const headTarget = head ? head.replace(/^ref:\s+/, "").split(/\s+/)[0] : null;
  const refCount = lines.filter((l) => !l.startsWith("ref: ")).length;
  return {
    source: r.cmd,
    ok: true,
    summary: `${refCount} refs${headTarget ? `, HEAD -> ${headTarget}` : ""}`,
    refCount,
    headTarget,
  };
}

async function probeAnonymousApi(forge: ForgeInfo | null): Promise<ApiProbeOutcome> {
  const base: Omit<ApiProbeOutcome, "source" | "ok" | "summary"> = { status: null, body: null, rateLimitRemaining: null };
  if (!forge) return { ...base, source: "(no forge)", ok: false, skipped: true, summary: "skipped: no forge remote detected" };
  if (!forge.apiUrl) {
    return { ...base, source: "(none)", ok: false, skipped: true, summary: `no anonymous API probe implemented for ${forge.kind} (${forge.host})` };
  }
  const source = `GET ${forge.apiUrl}`;
  try {
    const res = await fetch(forge.apiUrl, {
      headers: { Accept: "application/json", "User-Agent": "mendophyte-preflight" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "follow",
    });
    const rl = res.headers.get("x-ratelimit-remaining") ?? res.headers.get("ratelimit-remaining");
    const rateLimitRemaining = rl !== null && rl !== "" && !Number.isNaN(Number(rl)) ? Number(rl) : null;
    let body: Record<string, unknown> | null = null;
    if (res.ok) {
      try {
        const j = await res.json();
        if (j && typeof j === "object" && !Array.isArray(j)) body = j as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    const rlNote = rateLimitRemaining !== null ? ` (rate limit remaining: ${rateLimitRemaining})` : "";
    return {
      source,
      ok: res.ok,
      status: res.status,
      body,
      rateLimitRemaining,
      summary: `HTTP ${res.status}${rlNote}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? `timed out after ${PROBE_TIMEOUT_MS}ms` : e.message) : String(e);
    return { ...base, source, ok: false, summary: `request failed: ${msg}` };
  }
}

export async function checkCapability(repoDir: string, forge: ForgeInfo | null): Promise<CapabilityReport> {
  const [authCli, lsRemote, anonymousApi] = await Promise.all([
    probeAuthCli(forge),
    probeLsRemote(repoDir),
    probeAnonymousApi(forge),
  ]);

  const notes: string[] = [];
  let tier: CapabilityTier;
  if (authCli.ok) {
    tier = "full";
  } else if (anonymousApi.ok) {
    tier = "partial";
    notes.push("Anonymous API reads work but are rate-limited; assignment state, CI status and review-round behaviour may not be readable.");
  } else if (lsRemote.ok) {
    tier = "partial";
    notes.push(
      "Only git metadata is reachable (ls-remote). The forge API is not: open issues, assignments, maintainer comments, CI state and PR shape are unobservable unless the user pastes them in."
    );
  } else {
    tier = "local-only";
    notes.push("Neither the forge API nor the remote is reachable: everything forge-side is unobservable. Archived/public status must be confirmed by the user.");
  }
  if (forge && forge.kind === "unknown") {
    notes.push(`The remote host ${forge.host} is not a forge Mendophyte knows how to probe; forge facts are unobserved even if the remote itself is reachable.`);
  }
  if (!forge) notes.push("No `origin` remote: this looks like a purely local repository.");

  return { forge, authCli, lsRemote, anonymousApi, tier, notes };
}
