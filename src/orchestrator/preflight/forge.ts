/**
 * Forge identification from the `origin` remote URL.
 *
 * Only what later probes need: which API family to talk to and the
 * owner/repo path. Anything unrecognised is reported as `unknown` so the
 * agent labels forge facts unobserved instead of guessing.
 */

export type ForgeKind = "github" | "gitlab" | "gitea" | "bitbucket" | "sourcehut" | "unknown";

export interface ForgeInfo {
  kind: ForgeKind;
  host: string;
  /** Full project path, e.g. `owner/repo` or `group/subgroup/project`. */
  path: string;
  owner: string;
  repo: string;
  /** Browser URL for the repository. */
  webUrl: string;
  /** REST endpoint that returns repository metadata, when the forge is supported. */
  apiUrl: string | null;
  /** The remote URL as given. */
  remoteUrl: string;
}

const KNOWN_HOSTS: Record<string, ForgeKind> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "gitea",
  "gitea.com": "gitea",
  "bitbucket.org": "bitbucket",
  "git.sr.ht": "sourcehut",
};

function guessKindFromHost(host: string): ForgeKind {
  if (KNOWN_HOSTS[host]) return KNOWN_HOSTS[host];
  if (/(^|\.)gitlab\./i.test(host) || /^gitlab\b/i.test(host)) return "gitlab";
  if (/(^|\.)github\./i.test(host)) return "github";
  if (/(^|\.)(gitea|forgejo|codeberg)\./i.test(host)) return "gitea";
  return "unknown";
}

/** Parses https://, ssh://, and scp-style (`git@host:path`) remote URLs. Returns null if unparseable. */
export function parseRemoteUrl(remoteUrl: string): ForgeInfo | null {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  let host: string | null = null;
  let path: string | null = null;

  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([^\s]+)$/.exec(raw);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(raw);
      if (!/^(https?|ssh|git|git\+ssh):$/.test(u.protocol)) return null;
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (!host || !path) return null;

  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  // sourcehut paths look like ~user/repo
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const kind = guessKindFromHost(host.toLowerCase());
  const owner = segments.slice(0, -1).join("/");
  const repo = segments[segments.length - 1];
  const webUrl = `https://${host}/${path}`;

  let apiUrl: string | null = null;
  switch (kind) {
    case "github":
      apiUrl =
        host === "github.com"
          ? `https://api.github.com/repos/${owner}/${repo}`
          : `https://${host}/api/v3/repos/${owner}/${repo}`;
      break;
    case "gitlab":
      apiUrl = `https://${host}/api/v4/projects/${encodeURIComponent(path)}`;
      break;
    case "gitea":
      apiUrl = `https://${host}/api/v1/repos/${owner}/${repo}`;
      break;
    default:
      apiUrl = null;
  }

  return { kind, host, path, owner, repo, webUrl, apiUrl, remoteUrl: raw };
}
