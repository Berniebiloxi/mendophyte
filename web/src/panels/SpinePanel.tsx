import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useActiveSession, useUi } from "../store.js";
import type { ArtifactEntry } from "../types.js";

/**
 * The progress spine: a vine growing up the wall. Phases 0-5 are nodes
 * along it, the grown part of the vine reaches the current phase, and the
 * artifacts bud off the node whose phase produces them. Verification
 * passing is the "mend" mark at the Fix node.
 */
const PHASES = [
  { n: 0, name: "Entry", buds: [] as string[] },
  { n: 1, name: "Recon", buds: ["A"] },
  { n: 2, name: "Orientation", buds: ["D"] },
  { n: 3, name: "Triage", buds: ["B"] },
  { n: 4, name: "Fix", buds: ["C"] },
  { n: 5, name: "Submission", buds: ["E", "F"] },
];
const ARTIFACT_NAMES: Record<string, string> = { A: "Recon Notes", B: "Triage Record", C: "The Fix", D: "Glossary", E: "Submission", F: "Feedback Log" };

/** Which artifacts appear to exist, from file names in the artifact home. */
function detectBuds(entries: ArtifactEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const n = e.name.toLowerCase();
    const lead = /^([a-f])[-_ .]/i.exec(e.name)?.[1]?.toUpperCase();
    if (lead) out.add(lead);
    if (/recon/.test(n)) out.add("A");
    if (/triage/.test(n)) out.add("B");
    if (/\bfix\b|fix-|fix_/.test(n)) out.add("C");
    if (/glossary/.test(n)) out.add("D");
    if (/submission|pull-request|pr-draft|pr_draft/.test(n)) out.add("E");
    if (/feedback/.test(n)) out.add("F");
  }
  return out;
}

export function SpinePanel() {
  const s = useActiveSession();
  const { verification, events } = useUi();
  const [buds, setBuds] = useState<Set<string>>(new Set());
  const phase = s?.lastState?.phase ?? null;
  const complete = s?.lastState?.phase_complete ?? false;
  const list = s ? events[s.id] ?? [] : [];
  const turns = list.filter((e) => e.event === "turn").length;
  const lastArtifacts = [...list].reverse().find((e) => e.event === "artifacts");

  useEffect(() => {
    if (!s) return setBuds(new Set());
    let live = true;
    api.artifacts(s.id).then((r) => live && setBuds(detectBuds(r.entries))).catch(() => {});
    return () => {
      live = false;
    };
  }, [s?.id, turns]);
  // Live: the server's artifact-home watcher pushes fresh listings.
  useEffect(() => {
    if (lastArtifacts) setBuds(detectBuds((lastArtifacts.data as { entries: ArtifactEntry[] }).entries));
  }, [lastArtifacts?.seq]);

  const lastRun = s ? verification[s.id]?.runs[0] : undefined;

  // geometry: vertical, phase 0 at bottom
  const W = 230;
  const H = 400;
  const top = 34;
  const bottom = H - 30;
  const x = (i: number) => 58 + (i % 2 === 0 ? 0 : 22);
  const y = (i: number) => bottom - (i * (bottom - top)) / 5;
  let d = `M ${x(0)} ${y(0)}`;
  for (let i = 1; i <= 5; i++) {
    const cx = (x(i - 1) + x(i)) / 2 + (i % 2 === 0 ? -26 : 26);
    const cy = (y(i - 1) + y(i)) / 2;
    d += ` Q ${cx} ${cy} ${x(i)} ${y(i)}`;
  }
  const total = 1000;
  const grownFrac = phase === null ? 0 : Math.min(1, (phase + (complete ? 1 : 0.45)) / 5);

  return (
    <div className="panel spine">
      <h2>Progress</h2>
      {!s && <div className="empty">Start a session and the vine starts growing.</div>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={s ? `Phase ${phase ?? "not started"}` : "no session"}>
        <path className="vine-path" d={d} />
        <path className="vine-grown" d={d} pathLength={total} strokeDasharray={`${grownFrac * total} ${total}`} />
        {PHASES.map((p, i) => {
          const done = phase !== null && (p.n < phase || (p.n === phase && complete));
          const now = phase === p.n && !complete;
          const cls = done ? "node done" : now ? "node now" : "node";
          return (
            <g key={p.n}>
              {now && <circle className="pulse" cx={x(i)} cy={y(i)} r={9} />}
              {/* a leaf on each grown node */}
              <path className={`leaf${done || now ? "" : " dormant"}`} d={`M ${x(i) - 6} ${y(i) - 10} q -14 -14 -4 -26 q 12 6 4 26 z`} />
              <circle className={cls} cx={x(i)} cy={y(i)} r={7} />
              <text className={`label${done || now ? "" : " dim"}`} x={x(i) + 16} y={y(i) + 4}>
                {p.n} · {p.name}
              </text>
              {p.n === 4 && lastRun && (
                <g transform={`translate(${x(i) - 30} ${y(i) - 6})`}>
                  {lastRun.allPassed ? (
                    <path className="mend" d="M 0 6 l 4 4 l 8 -9" />
                  ) : (
                    <path className="mend bad" d="M 1 1 l 10 10 M 11 1 l -10 10" />
                  )}
                </g>
              )}
              {p.buds.map((b, k) => {
                const bx = x(i) + 120 + k * 22;
                const by = y(i) - 2;
                const open = buds.has(b);
                return (
                  <g key={b}>
                    <line x1={x(i) + 8} y1={y(i)} x2={bx - 6} y2={by} stroke="var(--m-vine-dormant)" strokeWidth={1} strokeDasharray={open ? undefined : "2 3"} />
                    <circle className={`bud${open ? " open" : ""}`} cx={bx} cy={by} r={4.5}>
                      <title>
                        Artifact {b} · {ARTIFACT_NAMES[b]} {open ? "(present)" : "(not yet)"}
                      </title>
                    </circle>
                    <text className="budlabel" x={bx - 3} y={by + 14}>
                      {b}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {s && (
        <div className="faint" style={{ fontSize: 11 }}>
          {phase === null ? "Waiting for the first turn." : complete ? `Phase ${phase} complete.` : `In phase ${phase}.`}{" "}
          {lastRun ? (lastRun.allPassed ? "Last verification passed." : "Last verification not green.") : ""}
        </div>
      )}
    </div>
  );
}
