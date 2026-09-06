import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One running diagnostic log per server process, as a Markdown file the
 * user can hand back for debugging: every HTTP request, every socket
 * frame in and out (summarised), every session event, every approval and
 * question, every UI action the browser reports (button presses, field
 * changes, store actions, JS errors), plus process-level errors.
 *
 * Lives under ~/.mendophyte/logs, never inside a target repository.
 * Bodies are truncated and obvious secrets are redacted before writing.
 */

export type DiagSource = "server" | "http" | "ws" | "session" | "approval" | "question" | "ui" | "error" | "agent";

export interface DiagEntry {
  at: string;
  source: DiagSource;
  text: string;
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FIELD = 400;

const SECRET_PATTERNS: RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  /\b(sk-[A-Za-z0-9]{20,})\b/g,
  /\b(glpat-[A-Za-z0-9_-]{20,})\b/g,
  /(authorization"?\s*[:=]\s*"?)(bearer\s+)?[A-Za-z0-9._-]{12,}/gi,
  /(token"?\s*[:=]\s*")[^"]{8,}(")/gi,
];

export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m, a) => (typeof a === "string" && m.startsWith(a) && /[:=]/.test(a) ? `${a}[redacted]` : "[redacted]"));
  return out;
}

export function truncate(s: string, n = MAX_FIELD): string {
  return s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s;
}

/** A compact one-line rendering of an arbitrary value for the log. */
export function brief(v: unknown, n = MAX_FIELD): string {
  if (v === undefined) return "";
  if (typeof v === "string") return truncate(redact(v.replace(/\s+/g, " ")), n);
  try {
    return truncate(redact(JSON.stringify(v)), n);
  } catch {
    return truncate(String(v), n);
  }
}

export function defaultLogDir(): string {
  return path.join(os.homedir(), ".mendophyte", "logs");
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

export class DiagnosticLog {
  readonly path: string;
  private bytes = 0;
  private rotated = 0;
  private enabled: boolean;
  private headerWritten = false;
  private readonly dir: string;

  constructor(opts: { dir?: string; name?: string; enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? true;
    this.dir = opts.dir ?? defaultLogDir();
    this.path = path.join(this.dir, `${opts.name ?? `mendophyte-${stamp()}`}.md`);
    if (this.enabled) this.writeHeader();
  }

  private writeHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.raw(
        [
          `# Mendophyte debug log`,
          ``,
          `Started ${new Date().toISOString()} · pid ${process.pid} · node ${process.version} · ${process.platform}/${process.arch} · ${os.release()}`,
          ``,
          `Hand this file back for diagnosis. Secrets that look like tokens are redacted; long bodies are truncated.`,
          `Sources: server, http, ws, session, approval, question, ui (browser), agent, error.`,
          ``,
          `| time | src | what |`,
          `|---|---|---|`,
          ``,
        ].join("\n")
      );
    } catch {
      /* logging must never take the server down */
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Pause or resume collection. The header is written once; a pause/resume leaves a marker. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    if (!on) this.log("server", "log collection paused by the user");
    this.enabled = on;
    if (on) {
      this.writeHeader();
      this.log("server", "log collection resumed by the user");
    }
  }

  log(source: DiagSource, text: string, at = new Date().toISOString()): void {
    if (!this.enabled) return;
    const line = `| ${at.slice(11, 23)} | ${source} | ${redact(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ⏎ ")} |\n`;
    this.raw(line);
  }

  /** Several UI entries at once, each with the browser's own timestamp. */
  logMany(entries: DiagEntry[]): void {
    for (const e of entries) this.log(e.source, e.text, e.at);
  }

  /** The last `n` lines, for the Debug panel. */
  tail(n = 200): string {
    try {
      const txt = readFileSync(this.path, "utf8");
      const lines = txt.split("\n");
      return lines.slice(Math.max(0, lines.length - n)).join("\n");
    } catch {
      return "";
    }
  }

  size(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  private raw(s: string): void {
    try {
      if (this.bytes + s.length > MAX_BYTES) this.rotate();
      appendFileSync(this.path, s);
      this.bytes += s.length;
    } catch {
      /* ignore */
    }
  }

  private rotate(): void {
    this.rotated += 1;
    const old = this.path.replace(/\.md$/, `.${this.rotated}.md`);
    try {
      renameSync(this.path, old);
    } catch {
      /* ignore */
    }
    this.bytes = 0;
    appendFileSync(this.path, `# Mendophyte debug log (continued from ${path.basename(old)})\n\n| time | src | what |\n|---|---|---|\n\n`);
  }
}

/** A log that writes nothing; tests and library use. */
export const NULL_LOG = new DiagnosticLog({ enabled: false });
