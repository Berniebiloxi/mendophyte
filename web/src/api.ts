import type { ArtifactEntry, BenchComparison, BenchDetection, BenchRun, DetectionReport, DiffReport, FeedbackEntry, FeedbackLog, FileContent, FileListing, FragilityReport, PreflightReport, SessionEvent, SessionSummary, SubmissionReport, TerminalInfo, VerificationRun } from "./types.js";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any)?.error ?? `${method} ${path} failed with ${res.status}`);
  return json as T;
}

export interface CreateSessionBody {
  repoDir: string;
  artifactHome?: string;
  repoUrl?: string;
  model?: string;
  preflight?: boolean;
}

export const api = {
  setDiagEnabled: (enabled: boolean) => call<{ enabled: boolean }>("POST", "/diag/enabled", { enabled }),
  diag: (tail = 300) => call<{ path: string; size: number; enabled: boolean; tail: string }>("GET", `/diag?tail=${tail}`),
  health: () => call<{ status: string; sessions: number; pendingApprovals: number }>("GET", "/health"),
  projects: () => call<{ projects: { name: string; artifactHome: string; modified: string }[] }>("GET", "/projects"),
  sessions: () => call<{ sessions: SessionSummary[] }>("GET", "/sessions"),
  createSession: (b: CreateSessionBody) => call<{ session: SessionSummary }>("POST", "/sessions", b),
  send: (id: string, text: string) => call<{ ok: true }>("POST", `/sessions/${id}/messages`, { text }),
  interrupt: (id: string) => call<{ ok: true }>("POST", `/sessions/${id}/interrupt`),
  end: (id: string) => call<{ ok: true }>("POST", `/sessions/${id}/end`),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/sessions/${id}`),
  events: (id: string, after = 0) => call<{ events: SessionEvent[] }>("GET", `/sessions/${id}/events?after=${after}`),
  resolveApproval: (id: string, approved: boolean, reason?: string) => call<{ ok: true }>("POST", `/approvals/${id}`, { approved, reason }),
  preflight: (id: string) => call<{ report: PreflightReport | null; facts: string | null }>("GET", `/sessions/${id}/preflight`),
  artifacts: (id: string) => call<{ artifactHome: string; exists: boolean; entries: ArtifactEntry[] }>("GET", `/sessions/${id}/artifacts`),
  fragility: (id: string) => call<{ report: FragilityReport; cached: boolean }>("GET", `/sessions/${id}/fragility`),
  verification: (id: string) => call<{ detected: DetectionReport | null; runs: VerificationRun[] }>("GET", `/sessions/${id}/verification`),
  detectVerification: (id: string) => call<{ detected: DetectionReport }>("POST", `/sessions/${id}/verification/detect`, {}),
  runVerification: (id: string, body: { useDetected?: boolean; checks?: { command: string; id?: string }[] }) =>
    call<{ run: VerificationRun }>("POST", `/sessions/${id}/verification`, body),
  diff: (id: string) => call<{ diff: DiffReport }>("GET", `/sessions/${id}/diff`),
  files: (id: string, withFragility: boolean) => call<{ listing: FileListing }>("GET", `/sessions/${id}/files${withFragility ? "?fragility=1" : ""}`),
  file: (id: string, p: string) => call<{ file: FileContent }>("GET", `/sessions/${id}/file?path=${encodeURIComponent(p)}`),
  artifactFile: (id: string, name: string) => call<{ file: FileContent }>("GET", `/sessions/${id}/artifacts/file?name=${encodeURIComponent(name)}`),
  terminals: (id: string) => call<{ terminals: TerminalInfo[] }>("GET", `/sessions/${id}/terminals`),
  createTerminal: (id: string, size: { cols: number; rows: number }) => call<{ terminal: TerminalInfo }>("POST", `/sessions/${id}/terminals`, size),
  killTerminal: (id: string, tid: string) => call<{ ok: true }>("DELETE", `/sessions/${id}/terminals/${tid}`),
  terminalHost: () => call<{ platform: string; shell: string; user: string; ptyError: string | null }>("GET", "/terminals/host"),
  submission: (id: string) => call<{ report: SubmissionReport | null; pollingSec: number | null }>("GET", `/sessions/${id}/submission`),
  refreshSubmission: (id: string, fetch: boolean) => call<{ report: SubmissionReport; pollingSec: number | null }>("POST", `/sessions/${id}/submission/refresh`, { fetch }),
  pollSubmission: (id: string, intervalSec: number | null) => call<{ pollingSec: number | null }>("POST", `/sessions/${id}/submission/poll`, { intervalSec }),
  feedback: (id: string) => call<{ log: FeedbackLog }>("GET", `/sessions/${id}/feedback`),
  addFeedback: (id: string, body: { lesson: string; tags?: string; source?: string }) => call<{ entry: FeedbackEntry; log: FeedbackLog }>("POST", `/sessions/${id}/feedback`, body),
  setFeedbackStale: (id: string, entryId: string, stale: boolean) => call<{ log: FeedbackLog }>("POST", `/sessions/${id}/feedback/${encodeURIComponent(entryId)}/stale`, { stale }),
  benchmarks: (id: string) => call<{ detection: BenchDetection; runs: BenchRun[] }>("GET", `/sessions/${id}/benchmarks`),
  runBenchmark: (id: string, body: { command: string; label?: string; tool?: string; cwd?: string }) => call<{ run: BenchRun }>("POST", `/sessions/${id}/benchmarks/run`, body),
  relabelBenchmark: (id: string, runId: string, label: string) => call<{ run: BenchRun }>("POST", `/sessions/${id}/benchmarks/${runId}/label`, { label }),
  compareBenchmarks: (id: string, baseline: string, after: string) => call<{ comparison: BenchComparison }>("GET", `/sessions/${id}/benchmarks/compare?baseline=${encodeURIComponent(baseline)}&after=${encodeURIComponent(after)}`),
};
