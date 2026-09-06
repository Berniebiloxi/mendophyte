import type { ForgeInfo } from "./forge.js";
import type { ApiProbeOutcome } from "./capability.js";

/**
 * Phase 0, step 4: repo health — exists, public, not archived/read-only.
 *
 * Derived entirely from the anonymous API body captured in step 3, so it
 * costs no extra request. Every field is tri-state: true / false / null
 * (unobserved), and the agent is told which.
 */

export interface RepoHealth {
  observed: boolean;
  /** Why fields are null, when they are. */
  reason: string | null;
  exists: boolean | null;
  public: boolean | null;
  archived: boolean | null;
  /** GitHub `disabled`, i.e. access switched off by the host. */
  disabled: boolean | null;
  /** Read-only mirror of a project hosted elsewhere (Gitea `mirror`, GitHub `mirror_url`). */
  mirror: boolean | null;
  fork: boolean | null;
  forkOf: string | null;
  defaultBranch: string | null;
  openIssues: number | null;
  stars: number | null;
  lastActivity: string | null;
  issuesEnabled: boolean | null;
  source: string;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function assessHealth(forge: ForgeInfo | null, api: ApiProbeOutcome): RepoHealth {
  const empty: RepoHealth = {
    observed: false,
    reason: null,
    exists: null,
    public: null,
    archived: null,
    disabled: null,
    mirror: null,
    fork: null,
    forkOf: null,
    defaultBranch: null,
    openIssues: null,
    stars: null,
    lastActivity: null,
    issuesEnabled: null,
    source: api.source,
  };

  if (!forge) return { ...empty, reason: "no forge remote" };
  if (api.skipped) return { ...empty, reason: api.summary };

  if (api.status === 404) {
    // On every supported forge an anonymous 404 means "no such public repo":
    // either it doesn't exist or it's private. Existence itself is unknown.
    return { ...empty, observed: true, reason: "HTTP 404 anonymously: the repository is either private or does not exist at this path", exists: null, public: false };
  }
  if (!api.ok || !api.body) {
    return { ...empty, reason: `API probe did not return data (${api.summary})` };
  }

  const b = api.body;
  switch (forge.kind) {
    case "github": {
      const parent = b.parent as Record<string, unknown> | undefined;
      return {
        ...empty,
        observed: true,
        exists: true,
        public: b.private === undefined ? true : !b.private,
        archived: bool(b.archived),
        disabled: bool(b.disabled),
        mirror: b.mirror_url === undefined ? null : b.mirror_url !== null,
        fork: bool(b.fork),
        forkOf: str(parent?.full_name),
        defaultBranch: str(b.default_branch),
        openIssues: num(b.open_issues_count),
        stars: num(b.stargazers_count),
        lastActivity: str(b.pushed_at),
        issuesEnabled: bool(b.has_issues),
      };
    }
    case "gitlab": {
      const forkedFrom = b.forked_from_project as Record<string, unknown> | undefined;
      return {
        ...empty,
        observed: true,
        exists: true,
        public: b.visibility === undefined ? true : b.visibility === "public",
        archived: bool(b.archived),
        disabled: null,
        mirror: bool(b.mirror),
        fork: forkedFrom ? true : b.forked_from_project === null ? false : null,
        forkOf: str(forkedFrom?.path_with_namespace),
        defaultBranch: str(b.default_branch),
        openIssues: num(b.open_issues_count),
        stars: num(b.star_count),
        lastActivity: str(b.last_activity_at),
        issuesEnabled: bool(b.issues_enabled),
      };
    }
    case "gitea": {
      const parent = b.parent as Record<string, unknown> | undefined;
      return {
        ...empty,
        observed: true,
        exists: true,
        public: b.private === undefined ? true : !b.private,
        archived: bool(b.archived),
        disabled: null,
        mirror: bool(b.mirror),
        fork: bool(b.fork),
        forkOf: str(parent?.full_name),
        defaultBranch: str(b.default_branch),
        openIssues: num(b.open_issues_count),
        stars: num(b.stars_count),
        lastActivity: str(b.updated_at),
        issuesEnabled: bool(b.has_issues),
      };
    }
    default:
      return { ...empty, reason: `no health mapping for forge kind ${forge.kind}` };
  }
}
