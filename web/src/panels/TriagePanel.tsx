import { useState } from "react";
import { store, useActiveSession } from "../store.js";
import type { CriterionScore, DeepAssessment, Triage, TriageCandidate } from "../types.js";

/**
 * Phase 3 as a board, not prose: one card per candidate with the named
 * criteria from 03-triage.md as chips (or a matrix), then a single card
 * with the danger gauge once a task is chosen. Driven only by the
 * agent's structured `triage` field.
 */

const BUG_ORDER = [
  "reproducibility",
  "staleness_or_claimed",
  "discussion_complexity",
  "bisectability",
  "environment_hardware_fit",
  "project_health",
  "maintainer_receptiveness",
  "root_cause_location",
  "determinism",
  "data_state_dependencies",
  "label_signal",
];
const PERF_ORDER = ["profiling_signal", "baseline_measurability", "nondeterminism", "regression_safety", "hardware_criticality", "maintainer_receptiveness_perf"];

const LABEL: Record<string, string> = {
  reproducibility: "repro",
  staleness_or_claimed: "claimed/stale",
  discussion_complexity: "discussion",
  bisectability: "bisectable",
  environment_hardware_fit: "env fit",
  project_health: "project health",
  maintainer_receptiveness: "maintainers",
  root_cause_location: "root cause here",
  determinism: "deterministic",
  data_state_dependencies: "data/state",
  label_signal: "labels",
  profiling_signal: "profile",
  baseline_measurability: "baseline",
  nondeterminism: "variance",
  regression_safety: "regression check",
  hardware_criticality: "hardware",
  maintainer_receptiveness_perf: "perf welcome",
};
const LONG: Record<string, string> = {
  reproducibility: "Reproducibility signal (heavily weighted)",
  staleness_or_claimed: "Staleness / already-claimed signal",
  discussion_complexity: "Discussion-complexity signal",
  bisectability: "Bisectability signal",
  environment_hardware_fit: "Environment / hardware fit",
  project_health: "Project health (CI on main)",
  maintainer_receptiveness: "Maintainer receptiveness",
  root_cause_location: "Root-cause location (in this repo?)",
  determinism: "Determinism",
  data_state_dependencies: "Data / state dependencies",
  label_signal: "Label signal (minor)",
  profiling_signal: "Profiling signal",
  baseline_measurability: "Baseline measurability",
  nondeterminism: "Nondeterminism as the default",
  regression_safety: "Regression safety",
  hardware_criticality: "Hardware criticality",
  maintainer_receptiveness_perf: "Maintainer receptiveness to perf work",
};

const VALUE_CLS: Record<CriterionScore["value"], string> = { positive: "ok", negative: "bad", neutral: "", unobserved: "unobs" };
const VALUE_GLYPH: Record<CriterionScore["value"], string> = { positive: "+", negative: "−", neutral: "·", unobserved: "?" };

function orderFor(t: Triage): string[] {
  return t.task_type === "performance" ? PERF_ORDER : BUG_ORDER;
}

function Chip({ s }: { s: CriterionScore }) {
  return (
    <span className={`tag ${VALUE_CLS[s.value]} tri-chip`} title={`${LONG[s.criterion] ?? s.criterion}: ${s.value}${s.note ? ` — ${s.note}` : ""}`}>
      {VALUE_GLYPH[s.value]} {LABEL[s.criterion] ?? s.criterion}
    </span>
  );
}

function Card({ c, order, onChoose, chosen }: { c: TriageCandidate; order: string[]; onChoose: (c: TriageCandidate) => void; chosen: boolean }) {
  const byC = Object.fromEntries(c.scores.map((s) => [s.criterion, s]));
  const url = /^https?:\/\//.test(c.source) ? c.source : null;
  return (
    <div className={`card tri-card${chosen ? " chosen" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row">
          <span className="tag accent">#{c.rank}</span>
          <b>{c.title}</b>
        </span>
        {url ? <a href={url} target="_blank" rel="noreferrer" className="faint">{c.source.replace(/^https?:\/\//, "").slice(0, 40)}</a> : <span className="faint">{c.source}</span>}
      </div>
      <div className="muted" style={{ margin: "4px 0 6px" }}>{c.reason}</div>
      <div className="row" style={{ gap: 4 }}>
        {order.filter((k) => byC[k]).map((k) => <Chip key={k} s={byC[k]} />)}
        {c.scores.filter((s) => !order.includes(s.criterion)).map((s) => <Chip key={s.criterion} s={s} />)}
      </div>
      {!chosen && (
        <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
          <button className="btn sm primary" onClick={() => onChoose(c)}>Take this into the deep pass</button>
        </div>
      )}
    </div>
  );
}

function Matrix({ t, order }: { t: Triage; order: string[] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tri-matrix">
        <thead>
          <tr>
            <th>candidate</th>
            {order.map((k) => <th key={k} title={LONG[k]}>{LABEL[k]}</th>)}
          </tr>
        </thead>
        <tbody>
          {t.candidates.map((c) => {
            const byC = Object.fromEntries(c.scores.map((s) => [s.criterion, s]));
            return (
              <tr key={c.id}>
                <td title={c.reason}><span className="tag accent">#{c.rank}</span> {c.title}</td>
                {order.map((k) => {
                  const s = byC[k];
                  return (
                    <td key={k} className={`cell ${s ? VALUE_CLS[s.value] : "none"}`} title={s ? `${LONG[k]}: ${s.value}${s.note ? ` — ${s.note}` : ""}` : `${LONG[k]}: not scored`}>
                      {s ? VALUE_GLYPH[s.value] : ""}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const DANGER = ["contained", "ripples", "blast_radius"] as const;
const DANGER_LABEL: Record<(typeof DANGER)[number], string> = { contained: "contained", ripples: "ripples", blast_radius: "blast radius" };

function Gauge({ d }: { d: DeepAssessment }) {
  const idx = DANGER.indexOf(d.danger);
  return (
    <div className="gauge">
      <div className="gauge-track">
        {DANGER.map((k, i) => (
          <div key={k} className={`gauge-seg s${i}${i <= idx ? " lit" : ""}${i === idx ? " now" : ""}`} title={DANGER_LABEL[k]}>
            {DANGER_LABEL[k]}
          </div>
        ))}
      </div>
      <div className="muted" style={{ marginTop: 6 }}>
        {d.danger_reason}
        {d.escalated_by_compatibility && <span className="tag bad" style={{ marginLeft: 6 }}>escalated by Phase 4 compatibility check</span>}
      </div>
    </div>
  );
}

const yn = (v: string) => (v === "yes" ? "ok" : v === "no" ? "bad" : "warn");

export function TriagePanel() {
  const s = useActiveSession();
  const [view, setView] = useState<"cards" | "matrix">("cards");
  const t = s?.lastState?.triage ?? s?.lastTriage ?? null;
  const live = Boolean(s?.lastState?.triage);

  const choose = (c: TriageCandidate) =>
    store.send(`I choose candidate #${c.rank}, "${c.title}" (${c.source}). Take it into the deep pass.`).catch((e) => store.toast(e.message));
  const bail = () =>
    store.send("Let's take the dignified way back to the candidate list: this task is harder than triage estimated. Please summarise what we learned, record it in Artifact B, and re-present the remaining candidates.").catch((e) => store.toast(e.message));

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;
  if (!t) return <div className="panel"><h2>Triage</h2><div className="empty">Triage hasn’t started. The board fills in during Phase 3 from the agent’s structured state, not from prose.</div></div>;

  const order = orderFor(t);
  const chosen = t.chosen ? t.candidates.find((c) => c.id === t.chosen!.candidate_id) : undefined;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Triage · {t.mode === "deep" ? "deep pass" : "shallow pass"}</h2>
        <span className="row">
          <span className="tag">{t.task_type}</span>
          {!live && <span className="tag" title="Phase 3 has moved on; this is the last triage state the agent reported">last known</span>}
          <span className="tag" style={{ cursor: "pointer" }} onClick={() => setView(view === "cards" ? "matrix" : "cards")}>{view === "cards" ? "matrix view" : "card view"}</span>
        </span>
      </div>

      {t.none_tractable && <div className="card" style={{ borderColor: "var(--m-warn)", marginTop: 8 }}><b>No safe, tractable starting point.</b> <span className="muted">{t.none_tractable}</span></div>}

      {t.mode === "deep" && t.chosen && (
        <>
          <h3>Chosen task</h3>
          <div className="card tri-deep">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{chosen ? `#${chosen.rank} ${chosen.title}` : t.chosen.candidate_id}</b>
              {chosen && <span className="faint">{chosen.source}</span>}
            </div>
            <Gauge d={t.chosen} />
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>root cause in this repo</dt><dd><span className={`tag ${yn(t.chosen.root_cause_in_repo)}`}>{t.chosen.root_cause_in_repo}</span></dd>
              <dt>{t.task_type === "performance" ? "baseline" : "reproducible"}</dt><dd><span className={`tag ${yn(t.chosen.reproducible_or_baseline)}`}>{t.chosen.reproducible_or_baseline.replace("_", " ")}</span>{t.chosen.reproducible_or_baseline === "not_yet" && <span className="faint"> — that is the first task</span>}</dd>
              <dt>scope</dt><dd>{t.chosen.scope.replace(/_/g, " ")}</dd>
              <dt>doability</dt><dd><span className={`tag ${yn(t.chosen.doability)}`}>{t.chosen.doability}</span> <span className="muted">{t.chosen.doability_reason}</span></dd>
              <dt>time to first build</dt><dd><span className={`tag ${t.chosen.time_to_first_build === "ok" ? "ok" : t.chosen.time_to_first_build === "blocked" ? "bad" : t.chosen.time_to_first_build === "slow" ? "warn" : ""}`}>{t.chosen.time_to_first_build}</span></dd>
            </dl>
            <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={bail} title="03-triage.md: a clear, dignified way back to the candidate list">Back to the candidate list</button>
            </div>
          </div>
        </>
      )}

      <h3>{t.mode === "deep" ? "Other candidates" : "Ranked candidates"}</h3>
      {t.candidates.length === 0 && <div className="empty">No candidates yet.</div>}
      {view === "matrix" ? (
        <Matrix t={t} order={order} />
      ) : (
        [...t.candidates].sort((a, b) => a.rank - b.rank).map((c) => <Card key={c.id} c={c} order={order} onChoose={choose} chosen={c.id === t.chosen?.candidate_id} />)
      )}
      <div className="row faint" style={{ marginTop: 6, gap: 10, fontSize: 11 }}>
        <span><span className="tag ok tri-chip">+</span> helps</span>
        <span><span className="tag bad tri-chip">−</span> counts against</span>
        <span><span className="tag tri-chip">·</span> neutral</span>
        <span><span className="tag unobs tri-chip">?</span> unobserved at this capability tier</span>
      </div>

      {t.filtered_out.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary>Filtered out ({t.filtered_out.length})</summary>
          {t.filtered_out.map((f, i) => (
            <div key={i} style={{ fontSize: 12, margin: "4px 0 0 12px" }}><b>{f.title}</b> <span className="muted">— {f.reason}</span></div>
          ))}
        </details>
      )}
    </div>
  );
}
