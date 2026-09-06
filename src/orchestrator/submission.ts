import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseRemoteUrl, type ForgeInfo } from "./preflight/forge.js";
import { failureReason, run } from "./preflight/run.js";
import { listArtifactHome } from "./preflight/local.js";
import { scanPolicyFiles } from "./preflight/policy.js";

/**
 * Phase 5 facts for the Submission panel (Artifact E), all deterministic:
 *   - the pull request for the current branch, from `gh` or the anonymous
 *     forge API, or UNOBSERVED
 *   - CI status for the head commit, normalised across check runs and
 *     commit statuses, polled by the server on a timer
 *   - PR template compliance: every heading and checkbox in the project's
 *     template, checked against the PR body (or the local Artifact E draft)
 *   - legal gate: does the project use DCO, and are the branch's commits
 *     signed off
 *   - branch sync: ahead/behind the base branch, unpushed commits
 * Nothing here is relayed through the model.
 */

export type CiStatus = "success" | "failure" | "pending" | "neutral" | "skipped" | "cancelled" | "unknown";

export interface CiCheck {
  name: string;
  status: CiStatus;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  kind: "check-run" | "status" | "unknown";
}

export interface CiReport {
  observed: boolean;
  source: string;
  sha: string | null;
  checks: CiCheck[];
  overall: CiStatus | null;
  reason: string | null;
}

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  author: string | null;
  reviewDecision: string | null;
  mergeable: string | null;
  labels: string[];
  updatedAt: string | null;
}

export interface TemplateItem {
  kind: "heading" | "checkbox";
  text: string;
  /** For checkboxes: whether the draft has it ticked; null when absent. */
  checked: boolean | null;
  present: boolean;
}

export interface TemplateReport {
  templatePath: string | null;
  otherTemplates: string[];
  draftSource: "pr-body" | "artifact" | null;
  draftPath: string | null;
  items: TemplateItem[];
  missing: number;
  unchecked: number;
  reason: string | null;
}

export interface LegalReport {
  dcoRequired: boolean | null;
  evidence: string | null;
  commitsChecked: number;
  signedOff: number;
  unsigned: string[];
}

export interface SyncReport {
  fetched: boolean;
  baseRemote: string | null;
  baseBranch: string | null;
  aheadOfBase: number | null;
  behindBase: number | null;
  upstream: string | null;
  unpushed: number | null;
  reason: string | null;
}

export interface SubmissionReport {
  ranAt: string;
  repoDir: string;
  branch: string | null;
  head: string | null;
  forge: ForgeInfo | null;
  baseRepo: ForgeInfo | null;
  pr: PrInfo | null;
  prSource: string;
  prObserved: boolean;
  prReason: string | null;
  ci: CiReport;
  template: TemplateReport;
  legal: LegalReport;
  sync: SyncReport;
  notes: string[];
}

export interface SubmissionOptions {
  repoDir: string;
  artifactHome: string;
  /** Run `git fetch` on the base remote first (network; modifies remote-tracking refs only). */
  fetch?: boolean;
  timeoutMs?: number;
}

const T = 20_000;

async function git(repoDir: string, args: string[], timeoutMs = T) {
  return run("git", args, { cwd: repoDir, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function remotes(repoDir: string): Promise<Record<string, string>> {
  const r = await git(repoDir, ["remote", "-v"]);
  const out: Record<string, string> = {};
  if (!r.ok) return out;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---- PR detection ---------------------------------------------------------

function normalizeCheckRun(c: any): CiCheck {
  const status: CiStatus =
    c.status !== "completed"
      ? "pending"
      : c.conclusion === "success"
        ? "success"
        : c.conclusion === "neutral"
          ? "neutral"
          : c.conclusion === "skipped"
            ? "skipped"
            : c.conclusion === "cancelled"
              ? "cancelled"
              : c.conclusion
                ? "failure"
                : "unknown";
  return { name: String(c.name ?? "check"), status, url: c.html_url ?? c.detailsUrl ?? c.details_url ?? null, startedAt: c.started_at ?? c.startedAt ?? null, completedAt: c.completed_at ?? c.completedAt ?? null, kind: "check-run" };
}

function normalizeStatusContext(s: any): CiCheck {
  const st = String(s.state ?? "");
  const status: CiStatus = st === "success" ? "success" : st === "pending" ? "pending" : st === "failure" || st === "error" ? "failure" : "unknown";
  return { name: String(s.context ?? "status"), status, url: s.target_url ?? s.targetUrl ?? null, startedAt: null, completedAt: s.updated_at ?? null, kind: "status" };
}

export function overallStatus(checks: CiCheck[]): CiStatus | null {
  if (!checks.length) return null;
  if (checks.some((c) => c.status === "failure")) return "failure";
  if (checks.some((c) => c.status === "pending")) return "pending";
  if (checks.some((c) => c.status === "cancelled")) return "cancelled";
  if (checks.every((c) => c.status === "skipped" || c.status === "neutral")) return "neutral";
  if (checks.some((c) => c.status === "unknown")) return "unknown";
  return "success";
}

async function prViaGh(repoDir: string, branch: string): Promise<{ pr: PrInfo | null; checks: CiCheck[] | null; observed: boolean; reason: string | null; source: string }> {
  const fields = "number,url,title,body,state,isDraft,baseRefName,headRefName,headRefOid,reviewDecision,mergeable,statusCheckRollup,author,updatedAt,labels";
  const r = await run("gh", ["pr", "view", branch, "--json", fields], { cwd: repoDir, timeoutMs: T });
  const source = `gh pr view ${branch} --json …`;
  if (r.ok) {
    try {
      const j = JSON.parse(r.stdout);
      const checks: CiCheck[] = (j.statusCheckRollup ?? []).map((c: any) => (c.__typename === "StatusContext" || c.context ? normalizeStatusContext(c) : normalizeCheckRun(c)));
      const pr: PrInfo = {
        number: j.number,
        url: j.url,
        title: j.title ?? "",
        body: j.body ?? "",
        state: j.state ?? "",
        isDraft: Boolean(j.isDraft),
        baseRef: j.baseRefName ?? "",
        headRef: j.headRefName ?? branch,
        headSha: j.headRefOid ?? null,
        author: j.author?.login ?? null,
        reviewDecision: j.reviewDecision || null,
        mergeable: j.mergeable || null,
        labels: (j.labels ?? []).map((l: any) => l.name),
        updatedAt: j.updatedAt ?? null,
      };
      return { pr, checks, observed: true, reason: null, source };
    } catch (e) {
      return { pr: null, checks: null, observed: false, reason: `gh returned unparsable JSON: ${e instanceof Error ? e.message : String(e)}`, source };
    }
  }
  const msg = (r.stderr + r.stdout).trim();
  if (/no pull requests found/i.test(msg)) return { pr: null, checks: null, observed: true, reason: `no pull request for branch ${branch}`, source };
  return { pr: null, checks: null, observed: false, reason: failureReason(r), source };
}

async function ghJson(url: string): Promise<{ ok: boolean; status: number | null; json: any; reason: string | null }> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "mendophyte-submission" }, signal: AbortSignal.timeout(T) });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (!res.ok) return { ok: false, status: res.status, json: null, reason: `HTTP ${res.status}${remaining === "0" ? " (rate limited)" : ""}` };
    return { ok: true, status: res.status, json: await res.json(), reason: null };
  } catch (e) {
    return { ok: false, status: null, json: null, reason: e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : String(e) };
  }
}

async function prViaAnonymousGithub(base: ForgeInfo, headOwner: string, branch: string): Promise<{ pr: PrInfo | null; observed: boolean; reason: string | null; source: string }> {
  const api = base.host === "github.com" ? "https://api.github.com" : `https://${base.host}/api/v3`;
  const url = `${api}/repos/${base.owner}/${base.repo}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${headOwner}:${branch}`)}`;
  const r = await ghJson(url);
  if (!r.ok) return { pr: null, observed: false, reason: r.reason, source: `GET ${url}` };
  const list: any[] = Array.isArray(r.json) ? r.json : [];
  if (!list.length) return { pr: null, observed: true, reason: `no pull request for ${headOwner}:${branch}`, source: `GET ${url}` };
  const j = list.sort((a, b) => (a.state === "open" ? -1 : 1) - (b.state === "open" ? -1 : 1))[0];
  return {
    pr: {
      number: j.number,
      url: j.html_url,
      title: j.title ?? "",
      body: j.body ?? "",
      state: j.merged_at ? "MERGED" : String(j.state ?? "").toUpperCase(),
      isDraft: Boolean(j.draft),
      baseRef: j.base?.ref ?? "",
      headRef: j.head?.ref ?? branch,
      headSha: j.head?.sha ?? null,
      author: j.user?.login ?? null,
      reviewDecision: null,
      mergeable: null,
      labels: (j.labels ?? []).map((l: any) => l.name),
      updatedAt: j.updated_at ?? null,
    },
    observed: true,
    reason: null,
    source: `GET ${url}`,
  };
}

async function ciViaAnonymousGithub(base: ForgeInfo, sha: string): Promise<CiReport> {
  const api = base.host === "github.com" ? "https://api.github.com" : `https://${base.host}/api/v3`;
  const runsUrl = `${api}/repos/${base.owner}/${base.repo}/commits/${sha}/check-runs?per_page=100`;
  const statusUrl = `${api}/repos/${base.owner}/${base.repo}/commits/${sha}/status`;
  const [runs, statuses] = await Promise.all([ghJson(runsUrl), ghJson(statusUrl)]);
  const checks: CiCheck[] = [];
  const reasons: string[] = [];
  if (runs.ok) checks.push(...((runs.json?.check_runs ?? []) as any[]).map(normalizeCheckRun));
  else reasons.push(`check-runs: ${runs.reason}`);
  if (statuses.ok) checks.push(...((statuses.json?.statuses ?? []) as any[]).map(normalizeStatusContext));
  else reasons.push(`status: ${statuses.reason}`);
  const observed = runs.ok || statuses.ok;
  return { observed, source: `GET ${runsUrl} + …/status`, sha, checks, overall: overallStatus(checks), reason: observed ? (reasons.length ? reasons.join("; ") : null) : reasons.join("; ") || "no data" };
}

// ---- template compliance -------------------------------------------------

export function parseTemplate(text: string): { kind: "heading" | "checkbox"; text: string }[] {
  const items: { kind: "heading" | "checkbox"; text: string }[] = [];
  let inCode = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      items.push({ kind: "heading", text: h[1].trim() });
      continue;
    }
    const c = /^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/.exec(line);
    if (c) items.push({ kind: "checkbox", text: c[1].trim() });
  }
  return items;
}

const norm = (s: string) => s.toLowerCase().replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();

export function checkCompliance(template: string, draft: string): TemplateItem[] {
  const items = parseTemplate(template);
  const lines = draft.split(/\r?\n/);
  const headings = new Set<string>();
  const boxes = new Map<string, boolean>();
  for (const raw of lines) {
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(raw.trimEnd());
    if (h) headings.add(norm(h[1]));
    const c = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(raw);
    if (c) boxes.set(norm(c[2]), c[1] !== " ");
  }
  const draftNorm = norm(draft);
  return items.map((it) => {
    if (it.kind === "heading") {
      const present = headings.has(norm(it.text)) || draftNorm.includes(norm(it.text));
      return { ...it, present, checked: null };
    }
    const key = norm(it.text);
    let found = boxes.has(key) ? key : [...boxes.keys()].find((k) => k.startsWith(key.slice(0, Math.max(12, Math.floor(key.length * 0.6)))));
    if (!found) return { ...it, present: false, checked: null };
    return { ...it, present: true, checked: boxes.get(found) ?? null };
  });
}

async function templateReport(repoDir: string, artifactHome: string, pr: PrInfo | null): Promise<TemplateReport> {
  const policy = await scanPolicyFiles(repoDir);
  const templates = policy.files.filter((f) => f.role === "pr-template").map((f) => f.path);
  const empty: TemplateReport = { templatePath: null, otherTemplates: [], draftSource: null, draftPath: null, items: [], missing: 0, unchecked: 0, reason: null };

  let draft: string | null = null;
  let draftSource: TemplateReport["draftSource"] = null;
  let draftPath: string | null = null;
  if (pr) {
    draft = pr.body;
    draftSource = "pr-body";
    draftPath = pr.url;
  } else {
    const home = await listArtifactHome(artifactHome);
    const e = home.entries.find((x) => !x.isDir && /^e[-_ .]|submission|pr-draft|pull[-_ ]request/i.test(x.name));
    if (e) {
      try {
        draft = await readFile(path.join(artifactHome, e.name), "utf8");
        draftSource = "artifact";
        draftPath = path.join(artifactHome, e.name);
      } catch {
        /* unreadable */
      }
    }
  }

  if (!templates.length) return { ...empty, draftSource, draftPath, reason: "no PR/MR template found in the repository (checked the usual locations)" };
  const templatePath = templates[0];
  let templateText: string;
  try {
    templateText = await readFile(path.join(repoDir, templatePath), "utf8");
  } catch (e) {
    return { ...empty, templatePath, otherTemplates: templates.slice(1), draftSource, draftPath, reason: `could not read ${templatePath}` };
  }
  if (draft === null) {
    const items = parseTemplate(templateText).map((it) => ({ ...it, present: false, checked: null as boolean | null }));
    return { templatePath, otherTemplates: templates.slice(1), draftSource: null, draftPath: null, items, missing: items.length, unchecked: 0, reason: "no PR yet and no Artifact E draft in the artifact home to compare" };
  }
  const items = checkCompliance(templateText, draft);
  return {
    templatePath,
    otherTemplates: templates.slice(1),
    draftSource,
    draftPath,
    items,
    missing: items.filter((i) => !i.present).length,
    unchecked: items.filter((i) => i.kind === "checkbox" && i.present && i.checked === false).length,
    reason: null,
  };
}

// ---- legal gate -------------------------------------------------------------

async function legalReport(repoDir: string, upstream: string | null): Promise<LegalReport> {
  const policy = await scanPolicyFiles(repoDir);
  let dcoRequired: boolean | null = null;
  let evidence: string | null = null;
  for (const f of policy.files) {
    const hit = f.legalHits.find((h) => /\bDCO\b|developer certificate of origin|signed-off-by|sign[- ]?off/i.test(h.text));
    if (hit) {
      dcoRequired = true;
      evidence = `${f.path} L${hit.line}: ${hit.text.slice(0, 120)}`;
      break;
    }
    if (f.role === "legal" && /^dco/i.test(path.basename(f.path))) {
      dcoRequired = true;
      evidence = `${f.path} exists`;
      break;
    }
  }
  if (dcoRequired === null) {
    dcoRequired = false;
    evidence = "no DCO/sign-off language found in CONTRIBUTING, templates or workflows";
  }
  const range = upstream ? `${upstream}..HEAD` : "-n 20";
  const r = await git(repoDir, ["log", ...(upstream ? [range] : ["-n", "20"]), "--format=%H%x1f%s%x1f%b%x1e"]);
  let commitsChecked = 0;
  let signedOff = 0;
  const unsigned: string[] = [];
  if (r.ok) {
    for (const rec of r.stdout.split("\x1e")) {
      if (!rec.trim()) continue;
      const [sha, subject, body] = rec.replace(/^\s+/, "").split("\x1f");
      commitsChecked++;
      if (/^Signed-off-by:/m.test(body ?? "")) signedOff++;
      else unsigned.push(`${sha.slice(0, 7)} ${(subject ?? "").slice(0, 60)}`);
    }
  }
  return { dcoRequired, evidence, commitsChecked, signedOff, unsigned: unsigned.slice(0, 10) };
}

// ---- branch sync -------------------------------------------------------------

async function syncReport(repoDir: string, baseRemote: string | null, baseBranch: string | null, upstream: string | null, fetch: boolean): Promise<SyncReport> {
  const out: SyncReport = { fetched: false, baseRemote, baseBranch, aheadOfBase: null, behindBase: null, upstream, unpushed: null, reason: null };
  if (fetch && baseRemote) {
    const f = await git(repoDir, ["fetch", "--quiet", baseRemote], 60_000);
    out.fetched = f.ok;
    if (!f.ok) out.reason = `git fetch ${baseRemote} failed: ${failureReason(f)}`;
  }
  // No remote HEAD ref locally (clone of an empty remote, or a pruned one):
  // assume the conventional default branch if its remote-tracking ref exists.
  if (!baseBranch && baseRemote) {
    for (const cand of ["main", "master", "develop"]) {
      const v = await git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${baseRemote}/${cand}`]);
      if (v.ok) {
        baseBranch = cand;
        out.baseBranch = cand;
        out.reason = `base branch assumed to be ${cand} from the local ref ${baseRemote}/${cand} (no ${baseRemote}/HEAD); confirm the real target branch`;
        break;
      }
    }
  }
  if (upstream) {
    const c = await git(repoDir, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    if (c.ok) {
      const [behind, ahead] = c.stdout.trim().split(/\s+/).map(Number);
      out.unpushed = Number.isFinite(ahead) ? ahead : null;
      void behind;
    }
  }
  if (baseRemote && baseBranch) {
    const ref = `${baseRemote}/${baseBranch}`;
    const c = await git(repoDir, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
    if (c.ok) {
      const [behind, ahead] = c.stdout.trim().split(/\s+/).map(Number);
      out.behindBase = Number.isFinite(behind) ? behind : null;
      out.aheadOfBase = Number.isFinite(ahead) ? ahead : null;
    } else if (!out.reason) out.reason = `no local ref for ${ref}${fetch ? "" : " (fetch to update)"}`;
  }
  return out;
}

// ---- main --------------------------------------------------------------------

export async function computeSubmission(opts: SubmissionOptions): Promise<SubmissionReport> {
  const { repoDir, artifactHome } = opts;
  const ranAt = new Date().toISOString();
  const notes: string[] = [];

  const [branchR, headR, rem] = await Promise.all([git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]), git(repoDir, ["rev-parse", "HEAD"]), remotes(repoDir)]);
  const branch = branchR.ok ? branchR.stdout.trim() : null;
  const head = headR.ok ? headR.stdout.trim() : null;
  const origin = rem.origin ? parseRemoteUrl(rem.origin) : null;
  const upstreamRemote = rem.upstream ? parseRemoteUrl(rem.upstream) : null;
  const baseRepo = upstreamRemote ?? origin;
  const baseRemoteName = rem.upstream ? "upstream" : rem.origin ? "origin" : null;

  const upR = await git(repoDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstream = upR.ok ? upR.stdout.trim() : null;

  // default base branch: the remote HEAD if known, else main/master guess (labelled)
  let baseBranch: string | null = null;
  if (baseRemoteName) {
    const h = await git(repoDir, ["symbolic-ref", "--quiet", `refs/remotes/${baseRemoteName}/HEAD`]);
    if (h.ok) baseBranch = h.stdout.trim().replace(`refs/remotes/${baseRemoteName}/`, "");
  }

  let pr: PrInfo | null = null;
  let prObserved = false;
  let prReason: string | null = null;
  let prSource = "(none)";
  let ci: CiReport = { observed: false, source: "(none)", sha: head, checks: [], overall: null, reason: "no forge" };

  if (!branch || branch === "HEAD") {
    prReason = "detached HEAD; no branch to look up";
  } else if (baseRepo?.kind === "github") {
    const viaGh = await prViaGh(repoDir, branch);
    prSource = viaGh.source;
    if (viaGh.observed) {
      pr = viaGh.pr;
      prObserved = true;
      prReason = viaGh.reason;
      if (pr && viaGh.checks) ci = { observed: true, source: "gh pr view statusCheckRollup", sha: pr.headSha, checks: viaGh.checks, overall: overallStatus(viaGh.checks), reason: viaGh.checks.length ? null : "no checks reported for the head commit" };
    } else {
      notes.push(`gh unavailable (${viaGh.reason}); falling back to the anonymous API`);
      const anon = await prViaAnonymousGithub(baseRepo, origin?.owner ?? baseRepo.owner, branch);
      prSource = anon.source;
      pr = anon.pr;
      prObserved = anon.observed;
      prReason = anon.reason;
    }
    if (!ci.observed) {
      const sha = pr?.headSha ?? head;
      if (sha) ci = await ciViaAnonymousGithub(baseRepo, sha);
      if (!pr && ci.observed && !ci.checks.length) ci.reason = `no CI recorded for ${sha?.slice(0, 7)} on ${baseRepo.path}; the commit may not be pushed yet`;
    }
  } else if (baseRepo) {
    prReason = `no PR/CI probe implemented for ${baseRepo.kind} (${baseRepo.host}); label PR and CI facts unobserved`;
    ci.reason = prReason;
  } else {
    prReason = "no origin remote";
  }
  if (pr && baseBranch === null) baseBranch = pr.baseRef || null;

  const [template, legal, sync] = await Promise.all([templateReport(repoDir, artifactHome, pr), legalReport(repoDir, upstream), syncReport(repoDir, baseRemoteName, baseBranch, upstream, Boolean(opts.fetch))]);
  if (!baseBranch) notes.push("base branch unknown (no remote HEAD ref locally); run fetch or open the PR to learn it");

  return { ranAt, repoDir, branch, head, forge: origin, baseRepo, pr, prSource, prObserved, prReason, ci, template, legal, sync, notes };
}

export function formatSubmission(r: SubmissionReport): string {
  const L: string[] = [];
  L.push(`## Submission status, computed by Mendophyte at ${r.ranAt}`);
  L.push("");
  L.push(`Branch ${r.branch ?? "?"} at ${r.head?.slice(0, 7) ?? "?"}${r.baseRepo ? `; base repository ${r.baseRepo.path} on ${r.baseRepo.host}` : "; no forge remote"}.`);
  L.push("");
  L.push("### Pull request");
  if (r.pr) {
    L.push(`- OBSERVED (\`${r.prSource}\`): #${r.pr.number} "${r.pr.title}" ${r.pr.state}${r.pr.isDraft ? " (draft)" : ""}, ${r.pr.headRef} -> ${r.pr.baseRef}, by ${r.pr.author ?? "?"}; review ${r.pr.reviewDecision ?? "none yet"}; mergeable ${r.pr.mergeable ?? "unobserved"}; ${r.pr.url}`);
  } else if (r.prObserved) L.push(`- OBSERVED (\`${r.prSource}\`): ${r.prReason}`);
  else L.push(`- UNOBSERVED: ${r.prReason}`);
  L.push("");
  L.push("### CI");
  if (r.ci.observed) {
    L.push(`- OBSERVED (\`${r.ci.source}\`) for ${r.ci.sha?.slice(0, 7) ?? "?"}: overall ${r.ci.overall ?? "no checks"}${r.ci.reason ? ` (${r.ci.reason})` : ""}`);
    for (const c of r.ci.checks) L.push(`  - ${c.status.toUpperCase()} ${c.name}${c.url ? ` ${c.url}` : ""}`);
  } else L.push(`- UNOBSERVED: ${r.ci.reason}`);
  L.push("");
  L.push("### PR template compliance");
  const t = r.template;
  if (!t.templatePath) L.push(`- OBSERVED: ${t.reason}`);
  else {
    L.push(`- template \`${t.templatePath}\`${t.otherTemplates.length ? ` (also: ${t.otherTemplates.join(", ")})` : ""}; draft compared: ${t.draftSource === "pr-body" ? "the PR body" : t.draftSource === "artifact" ? `Artifact E at ${t.draftPath}` : "none"}${t.reason ? ` (${t.reason})` : ""}`);
    for (const it of t.items) L.push(`  - ${it.present ? (it.kind === "checkbox" ? (it.checked ? "[x]" : "[ ]") : "present") : "MISSING"} ${it.kind}: ${it.text}`);
    L.push(`- ${t.missing} missing, ${t.unchecked} unchecked`);
  }
  L.push("");
  L.push("### Legal gate");
  L.push(`- DCO/sign-off required: ${r.legal.dcoRequired === null ? "unobserved" : r.legal.dcoRequired ? "yes" : "no evidence"} (${r.legal.evidence})`);
  L.push(`- branch commits checked: ${r.legal.commitsChecked}, signed off: ${r.legal.signedOff}${r.legal.unsigned.length ? `; unsigned: ${r.legal.unsigned.join("; ")}` : ""}`);
  L.push("");
  L.push("### Branch sync");
  const s = r.sync;
  L.push(`- upstream ${s.upstream ?? "none"}; unpushed commits ${s.unpushed ?? "unknown"}; vs ${s.baseRemote ?? "?"}/${s.baseBranch ?? "?"}: ahead ${s.aheadOfBase ?? "?"}, behind ${s.behindBase ?? "?"}${s.fetched ? " (after fetch)" : " (local refs; not fetched)"}${s.reason ? `; ${s.reason}` : ""}`);
  for (const n of r.notes) L.push(`- note: ${n}`);
  return L.join("\n");
}
