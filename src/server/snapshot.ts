import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionManager } from "./session-manager.js";

/**
 * A Markdown snapshot of one session: what was said, what the agent ran,
 * the last dashboard state, verification and submission. Written into the
 * artifact home under snapshots/ (outside the repository, like every
 * artifact) or handed back for download. The agent's own artifacts A–F
 * are the durable record; this is the human-readable session record.
 */
export function buildSnapshot(manager: SessionManager, id: string): { name: string; markdown: string } {
  const s = manager.get(id);
  if (!s) throw new Error("no such session");
  const when = new Date().toISOString();
  const L: string[] = [];
  L.push(`# Mendophyte session snapshot`, ``);
  L.push(`- repository: ${s.repoDir}`);
  if (s.repoUrl) L.push(`- forge: ${s.repoUrl}`);
  L.push(`- artifact home: ${s.artifactHome}`);
  L.push(`- model: ${s.model ?? "default"} · status: ${s.status} · started: ${s.createdAt} · snapshot: ${when}`);
  if (s.preflight) L.push(`- capability tier: ${s.preflight.tier}`);
  if (s.lastState) L.push(`- phase: ${s.lastState.phase}${s.lastState.phase_complete ? " (complete)" : ""}`);
  L.push(``);

  const st = s.lastState;
  if (st) {
    L.push(`## Dashboard state (last turn)`, ``);
    if (st.your_turn_items.length) {
      L.push(`Waiting on the user:`);
      for (const i of st.your_turn_items) L.push(`- [${i.kind}] ${i.prompt}${i.blocks !== "none" ? ` (locks ${i.blocks})` : ""}`);
      L.push(``);
    }
    const t = st.triage;
    if (t) {
      L.push(`Triage (${t.mode}): ${t.candidates.length} candidate(s)${t.chosen ? `, deep pass on ${t.chosen.candidate_id ?? "the chosen one"}` : ""}`, ``);
    }
    L.push("<details><summary>Raw state</summary>", "", "```json", JSON.stringify(st, null, 2), "```", "", "</details>", "");
  }

  const v = manager.verificationFor(id);
  if (v.runs.length) {
    L.push(`## Verification (${v.runs.length} run${v.runs.length === 1 ? "" : "s"}, newest first)`, ``);
    for (const run of v.runs) {
      L.push(`- ${run.ranAt} · ${run.allPassed ? "all passed" : `${run.counts.failed} failed`} · ${run.results.map((r) => `${r.id}: ${r.status}`).join(", ")}`);
    }
    L.push(``);
  }
  const sub = manager.submissionFor(id).report;
  if (sub) {
    L.push(`## Submission`, ``, "```json", JSON.stringify(sub, null, 2), "```", ``);
  }

  L.push(`## Conversation`, ``);
  for (const e of manager.events(id)) {
    const d: any = e.data;
    const t = e.at.slice(11, 19);
    switch (e.event) {
      case "user_text":
        if (d?.kickoff) L.push(`**${t} kickoff** (entry prompt + pre-flight facts, ${String(d.text).length} chars)`, ``);
        else L.push(`**${t} you:**`, ``, indent(String(d?.text ?? "")), ``);
        break;
      case "assistant_text":
        L.push(`**${t} agent:**`, ``, indent(String(d?.text ?? "")), ``);
        break;
      case "tool_use":
        L.push(`- ${t} \`${d?.name}\` ${JSON.stringify(d?.input ?? {}).slice(0, 300)}`);
        break;
      case "turn":
        L.push(`- ${t} turn ${d?.subtype}${d?.timing ? ` · ${(d.timing.wallMs / 1000).toFixed(1)}s` : ""}${d?.total_cost_usd != null ? ` · $${Number(d.total_cost_usd).toFixed(3)} so far` : ""}`, ``);
        break;
      case "error":
        L.push(`- ${t} **error** ${d?.message ?? ""}`);
        break;
      default:
        break;
    }
  }
  const stamp = when.replace(/[:.]/g, "-").replace("T", "_").replace(/Z$/, "");
  return { name: `snapshot-${stamp}.md`, markdown: L.join("\n") + "\n" };
}

function indent(s: string): string {
  return s.split(/\r?\n/).map((l) => `> ${l}`).join("\n");
}

export async function writeSnapshot(manager: SessionManager, id: string): Promise<{ path: string; name: string; bytes: number }> {
  const s = manager.get(id);
  if (!s) throw new Error("no such session");
  const { name, markdown } = buildSnapshot(manager, id);
  const dir = path.join(s.artifactHome, "snapshots");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await writeFile(p, markdown, "utf8");
  return { path: p, name, bytes: Buffer.byteLength(markdown) };
}
