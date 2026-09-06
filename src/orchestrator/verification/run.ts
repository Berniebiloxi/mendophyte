import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchGuardrail, type GuardrailRule } from "../guardrails.js";
import type { CheckKind, VerificationCheck } from "./detect.js";

/**
 * Runs verification commands and reports what actually happened. The only
 * source of a "passed" anywhere in Mendophyte is `exitCode === 0` (or an
 * empty output for no-output tools) observed here.
 *
 * Safety: commands are matched against the same guardrail list as the
 * agent's Bash tool and refused if they match, so this can't be used to
 * commit or push without the confirmation modal; cwd must stay inside the
 * repository; every run has a timeout.
 */

export type CheckStatus = "passed" | "failed" | "timeout" | "refused" | "error";

export interface CheckResult {
  id: string;
  kind: CheckKind;
  command: string;
  cwd: string;
  status: CheckStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  /** Last part of combined stdout+stderr. */
  outputTail: string;
  outputBytes: number;
  logPath: string | null;
  /** Why it was refused or errored. */
  reason?: string;
  successRule: "exit-zero" | "no-output";
}

export interface VerificationRun {
  id: string;
  ranAt: string;
  finishedAt: string;
  repoDir: string;
  results: CheckResult[];
  allPassed: boolean;
  counts: Record<CheckStatus, number>;
}

export interface RunOptions {
  repoDir: string;
  /** Logs go to `<artifactHome>/logs/`; omit to keep logs in memory only. */
  artifactHome?: string;
  checks: VerificationCheck[];
  timeoutMs?: number;
  tailBytes?: number;
  guardrails?: GuardrailRule[];
  env?: NodeJS.ProcessEnv;
  onProgress?: (e: VerificationProgress) => void;
  /** Stop after the first failure. Default false: run everything, report everything. */
  failFast?: boolean;
}

export type VerificationProgress =
  | { runId: string; phase: "start"; check: VerificationCheck; index: number; total: number }
  | { runId: string; phase: "finish"; result: CheckResult; index: number; total: number };

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_TAIL_BYTES = 16 * 1024;

function resolveCwd(repoDir: string, cwd?: string): { ok: true; abs: string } | { ok: false; reason: string } {
  const abs = path.resolve(repoDir, cwd ?? ".");
  const relToRepo = path.relative(repoDir, abs);
  if (relToRepo.startsWith("..") || path.isAbsolute(relToRepo)) return { ok: false, reason: `cwd ${cwd} is outside the repository` };
  return { ok: true, abs };
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "check";
}

async function runOne(check: VerificationCheck, opts: RunOptions, runId: string, logsDir: string | null): Promise<CheckResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const successRule = check.successRule ?? "exit-zero";
  const base = { id: check.id, kind: check.kind, command: check.command, successRule, startedAt, logPath: null as string | null };

  const guard = matchGuardrail(check.command, opts.guardrails);
  if (guard) {
    return { ...base, cwd: opts.repoDir, status: "refused", exitCode: null, signal: null, durationMs: 0, finishedAt: startedAt, outputTail: "", outputBytes: 0, reason: `refused by guardrail ${guard.ruleId} (${guard.description}); run it through your Bash tool so the user can confirm it` };
  }
  const cwd = resolveCwd(opts.repoDir, check.cwd);
  if (!cwd.ok) {
    return { ...base, cwd: check.cwd ?? opts.repoDir, status: "refused", exitCode: null, signal: null, durationMs: 0, finishedAt: startedAt, outputTail: "", outputBytes: 0, reason: cwd.reason };
  }

  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chunks: Buffer[] = [];
  let total = 0;

  return new Promise<CheckResult>((resolve) => {
    let child;
    try {
      child = spawn(check.command, {
        cwd: cwd.abs,
        shell: true,
        env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0", NO_COLOR: "1", ...(opts.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Own process group on POSIX so a timeout can kill the shell AND
        // whatever it started; otherwise the grandchild keeps the pipes open
        // and the run only ends when the command finishes on its own.
        detached: process.platform !== "win32",
      });
    } catch (e) {
      const finishedAt = new Date().toISOString();
      return resolve({ ...base, cwd: cwd.abs, status: "error", exitCode: null, signal: null, durationMs: Date.now() - t0, finishedAt, outputTail: "", outputBytes: 0, reason: e instanceof Error ? e.message : String(e) });
    }

    const collect = (b: Buffer) => {
      total += b.length;
      chunks.push(b);
      // keep memory bounded: retain roughly the last 4 MB
      let kept = chunks.reduce((n, c) => n + c.length, 0);
      while (kept > 4 * 1024 * 1024 && chunks.length > 1) kept -= chunks.shift()!.length;
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
        return;
      }
      try {
        process.kill(-child.pid, signal); // whole process group
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    const finish = async (code: number | null, signal: NodeJS.Signals | null, err?: Error) => {
      clearTimeout(timer);
      const finishedAt = new Date().toISOString();
      const all = Buffer.concat(chunks);
      const outputTail = all.subarray(Math.max(0, all.length - tailBytes)).toString("utf8");
      let logPath: string | null = null;
      if (logsDir) {
        try {
          logPath = path.join(logsDir, `${runId.slice(0, 8)}-${slug(check.id)}.log`);
          await writeFile(logPath, `$ ${check.command}\n(cwd ${cwd.abs}, started ${startedAt})\n\n` + all.toString("utf8") + `\n\n[exit ${code ?? "null"}${signal ? ` signal ${signal}` : ""}, ${Date.now() - t0} ms]\n`);
        } catch {
          logPath = null;
        }
      }
      let status: CheckStatus;
      let reason: string | undefined;
      if (err) {
        status = "error";
        reason = err.message;
      } else if (timedOut) {
        status = "timeout";
        reason = `no exit within ${Math.round(timeoutMs / 1000)}s`;
      } else if (successRule === "no-output") {
        status = code === 0 && all.toString("utf8").trim() === "" ? "passed" : "failed";
        if (status === "failed" && code === 0) reason = "command exited 0 but produced output (no-output rule)";
      } else {
        status = code === 0 ? "passed" : "failed";
      }
      resolve({ ...base, cwd: cwd.abs, status, exitCode: code, signal, durationMs: Date.now() - t0, finishedAt, outputTail, outputBytes: total, logPath, reason });
    };

    child.once("error", (e) => void finish(null, null, e));
    child.once("close", (code, signal) => void finish(code, signal));
  });
}

export async function runVerification(opts: RunOptions): Promise<VerificationRun> {
  const id = randomUUID();
  const ranAt = new Date().toISOString();
  let logsDir: string | null = null;
  if (opts.artifactHome) {
    logsDir = path.join(opts.artifactHome, "logs", `verification-${ranAt.replace(/[:.]/g, "-")}`);
    try {
      await mkdir(logsDir, { recursive: true });
    } catch {
      logsDir = null;
    }
  }
  const results: CheckResult[] = [];
  const total = opts.checks.length;
  for (let i = 0; i < total; i++) {
    const check = opts.checks[i];
    opts.onProgress?.({ runId: id, phase: "start", check, index: i, total });
    const r = await runOne(check, opts, id, logsDir);
    results.push(r);
    opts.onProgress?.({ runId: id, phase: "finish", result: r, index: i, total });
    if (opts.failFast && r.status !== "passed") break;
  }
  const counts: Record<CheckStatus, number> = { passed: 0, failed: 0, timeout: 0, refused: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  return { id, ranAt, finishedAt: new Date().toISOString(), repoDir: opts.repoDir, results, allPassed: results.length > 0 && results.every((r) => r.status === "passed"), counts };
}
