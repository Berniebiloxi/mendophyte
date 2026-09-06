import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Artifact F, the per-project feedback log (05-submission.md, section H):
 * durable lessons from real feedback, not transcripts. It lives in the
 * artifact home as a markdown file both the agent and the panel read, so
 * the on-disk format is fixed and small:
 *
 *   ## 2026-09-06T14:03:11Z · #conventions #tests
 *   Maintainers want regression tests under tests/unit/, not beside the source.
 *   Source: PR #482 review by @alice
 *
 * Append-only by design. The one permitted mutation is flagging an entry as
 * possibly stale (a `#stale` tag on its header), which is what the
 * meta-prompt asks for when live recon contradicts an old lesson.
 */

export const FEEDBACK_LOG_DEFAULT_NAME = "F-feedback-log.md";

export interface FeedbackEntry {
  /** The header timestamp, unique within the file. */
  id: string;
  at: string;
  tags: string[];
  lesson: string;
  source: string | null;
  stale: boolean;
}

export interface FeedbackLog {
  /** Where the log lives (or will be created). */
  path: string;
  exists: boolean;
  entries: FeedbackEntry[];
  preamble: string;
}

const HEADER_RE = /^## (\S+)(?:\s+·\s+(.*))?$/;

const PREAMBLE = [
  "# Feedback Log (Artifact F)",
  "",
  "Durable lessons from real feedback on this project: the lesson, not the transcript.",
  "Read on every resume; weighted above general merged history as a convention signal.",
  "If live recon contradicts an entry, the live signal wins and the entry is tagged #stale.",
  "",
  "Append entries in this exact shape (Mendophyte and the agent both parse it):",
  "",
  "    ## <ISO timestamp> · #tag #another-tag",
  "    The lesson, one or a few sentences.",
  "    Source: where it came from (PR/issue/comment/person)",
  "",
].join("\n");

export function parseFeedbackLog(text: string): { preamble: string; entries: FeedbackEntry[] } {
  const lines = text.split(/\r?\n/);
  const entries: FeedbackEntry[] = [];
  const preambleLines: string[] = [];
  let cur: { at: string; tags: string[]; body: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    const src = /^Source:\s*(.+)$/m.exec(body);
    const lesson = body.replace(/^Source:.*$/m, "").trim();
    const tags = cur.tags.filter((t) => t !== "stale");
    entries.push({ id: cur.at, at: cur.at, tags, lesson, source: src ? src[1].trim() : null, stale: cur.tags.includes("stale") });
    cur = null;
  };
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      const tags = (m[2] ?? "")
        .split(/\s+/)
        .filter((t) => t.startsWith("#"))
        .map((t) => t.slice(1).toLowerCase())
        .filter(Boolean);
      cur = { at: m[1], tags, body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
    else preambleLines.push(line);
  }
  flush();
  return { preamble: preambleLines.join("\n").trimEnd(), entries };
}

export function formatEntry(e: FeedbackEntry): string {
  const tags = [...e.tags, ...(e.stale ? ["stale"] : [])].map((t) => `#${t}`).join(" ");
  const out = [`## ${e.at}${tags ? ` · ${tags}` : ""}`, e.lesson.trim()];
  if (e.source) out.push(`Source: ${e.source.trim()}`);
  return out.join("\n") + "\n";
}

export function serializeFeedbackLog(preamble: string, entries: FeedbackEntry[]): string {
  const head = (preamble.trim() ? preamble.trimEnd() : PREAMBLE.trimEnd()) + "\n\n";
  return head + entries.map(formatEntry).join("\n");
}

/** Finds the log file in the artifact home: an existing file named F-… or containing "feedback", else the default name (may not exist yet). */
export async function locateFeedbackLog(artifactHome: string): Promise<{ path: string; exists: boolean }> {
  try {
    const names = await readdir(artifactHome);
    const hit = names.find((n) => /^f[-_ .].*\.(md|markdown|txt)$/i.test(n) || /feedback/i.test(n));
    if (hit) return { path: path.join(artifactHome, hit), exists: true };
  } catch {
    /* no artifact home yet */
  }
  return { path: path.join(artifactHome, FEEDBACK_LOG_DEFAULT_NAME), exists: false };
}

export async function readFeedbackLog(artifactHome: string): Promise<FeedbackLog> {
  const loc = await locateFeedbackLog(artifactHome);
  if (!loc.exists) return { path: loc.path, exists: false, entries: [], preamble: "" };
  let text: string;
  try {
    text = await readFile(loc.path, "utf8");
  } catch {
    return { path: loc.path, exists: false, entries: [], preamble: "" };
  }
  const { preamble, entries } = parseFeedbackLog(text);
  return { path: loc.path, exists: true, entries, preamble };
}

export function normalizeTags(tags: string[] | string | undefined): string[] {
  const raw = Array.isArray(tags) ? tags : (tags ?? "").split(/[\s,]+/);
  const out: string[] = [];
  for (let t of raw) {
    t = t.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "");
    if (t && t !== "stale" && !out.includes(t)) out.push(t);
  }
  return out;
}

export async function appendFeedbackEntry(artifactHome: string, input: { lesson: string; tags?: string[] | string; source?: string | null; at?: string }): Promise<{ entry: FeedbackEntry; log: FeedbackLog }> {
  const lesson = (input.lesson ?? "").trim();
  if (!lesson) throw new FeedbackLogError("lesson is required");
  const log = await readFeedbackLog(artifactHome);
  let at = (input.at ?? new Date().toISOString()).replace(/\.\d{3}Z$/, "Z");
  while (log.entries.some((e) => e.id === at)) at = at.replace(/Z$/, "") + "-1Z";
  const entry: FeedbackEntry = { id: at, at, tags: normalizeTags(input.tags), lesson, source: input.source?.trim() || null, stale: false };
  const entries = [...log.entries, entry];
  await writeFile(log.path, serializeFeedbackLog(log.preamble, entries), "utf8");
  return { entry, log: { ...log, exists: true, entries } };
}

export async function setFeedbackStale(artifactHome: string, id: string, stale: boolean): Promise<FeedbackLog> {
  const log = await readFeedbackLog(artifactHome);
  const e = log.entries.find((x) => x.id === id);
  if (!e) throw new FeedbackLogError(`no entry ${id}`);
  e.stale = stale;
  await writeFile(log.path, serializeFeedbackLog(log.preamble, log.entries), "utf8");
  return log;
}

export function formatFeedbackFacts(log: FeedbackLog, limit = 20): string[] {
  if (!log.exists || !log.entries.length) return ["- OBSERVED: no feedback log yet (Artifact F is created on the first entry)."];
  const L = [`- OBSERVED (\`${log.path}\`): ${log.entries.length} entr${log.entries.length === 1 ? "y" : "ies"}. Weight these above general merged history; if live recon contradicts one, say so and tag it #stale.`];
  for (const e of [...log.entries].reverse().slice(0, limit)) {
    L.push(`  - ${e.at}${e.tags.length ? ` [${e.tags.join(", ")}]` : ""}${e.stale ? " (flagged possibly stale)" : ""}: ${e.lesson.replace(/\s+/g, " ").slice(0, 240)}${e.source ? ` (source: ${e.source})` : ""}`);
  }
  if (log.entries.length > limit) L.push(`  - (${log.entries.length - limit} older entries in the file)`);
  return L;
}

export class FeedbackLogError extends Error {}
