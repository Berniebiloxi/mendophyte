import { execFile } from "node:child_process";

/**
 * Result of a shell probe. Never throws: a missing binary, a non-zero exit
 * and a timeout are all ordinary outcomes the report has to describe.
 */
export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or timed out. */
  error?: string;
  /** The command as it would be typed, for citing in the report. */
  cmd: string;
}

export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  const cmd = [file, ...args].join(" ");
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 8 * 1024 * 1024,
        env: opts.env ?? process.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (!err) return resolve({ ok: true, code: 0, stdout: out, stderr: errOut, cmd });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
        if (e.code === "ENOENT") {
          return resolve({ ok: false, code: null, stdout: out, stderr: errOut, error: `${file} is not installed or not on PATH`, cmd });
        }
        if (e.killed || e.signal === "SIGTERM") {
          return resolve({ ok: false, code: null, stdout: out, stderr: errOut, error: `timed out after ${opts.timeoutMs ?? 15_000}ms`, cmd });
        }
        const code = typeof e.code === "number" ? e.code : null;
        return resolve({ ok: false, code, stdout: out, stderr: errOut, error: code === null ? e.message : undefined, cmd });
      }
    );
  });
}

/** Short, single-line rendering of why a probe failed, for the report. */
export function failureReason(r: RunResult): string {
  if (r.error) return r.error;
  const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";
  return `exit ${r.code}${tail ? `: ${tail.slice(0, 160)}` : ""}`;
}
