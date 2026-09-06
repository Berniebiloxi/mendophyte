import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { store, useActiveSession, useUi } from "../store.js";
import type { BenchComparison, BenchDetection, BenchRun, BenchSample } from "../types.js";

/**
 * Performance sessions: the project's own benchmark output as a
 * distribution, not a single number. Baseline vs after per benchmark with
 * ±1 sd whiskers and the individual measurements as a dot strip; warm-up
 * shown from what the tool reports; the verdict states whether the change
 * clears the noise.
 */

function fmt(v: number, unit: BenchSample["unit"]): string {
  if (unit !== "ns") return `${v.toFixed(1)} ${unit}`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(3)} s`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(3)} ms`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)} µs`;
  return `${v.toFixed(1)} ns`;
}

/** Two series, fixed order: baseline first (blue), after second (green). Validated with the palette script for both schemes. */
const SERIES = { base: "var(--m-series-1)", after: "var(--m-series-2)" };

function Row({ row, max }: { row: BenchComparison["rows"][number]; max: number }) {
  const W = 420;
  const H = 54;
  const x = (v: number) => 4 + (v / max) * (W - 8);
  const bar = (s: BenchSample | null, y: number, color: string, hatched: boolean) => {
    if (!s) return <text x={4} y={y + 9} className="bm-dim">not in this run</text>;
    const sd = s.stddev ?? 0;
    return (
      <g>
        <rect x={4} y={y} width={Math.max(2, x(s.mean) - 4)} height={10} rx={3} fill={hatched ? "url(#bm-hatch)" : color} stroke={color} strokeWidth={hatched ? 1.2 : 0}>
          <title>{`${s.name}: mean ${fmt(s.mean, s.unit)}${s.stddev != null ? ` ± ${fmt(s.stddev, s.unit)} sd` : ""}, n=${s.n}${s.median != null ? `, median ${fmt(s.median, s.unit)}` : ""}${s.min != null && s.max != null ? `, range ${fmt(s.min, s.unit)}–${fmt(s.max, s.unit)}` : ""}`}</title>
        </rect>
        {s.stddev != null && (
          <g stroke="var(--m-ink)" strokeWidth={1.2}>
            <line x1={x(Math.max(0, s.mean - sd))} x2={x(s.mean + sd)} y1={y + 5} y2={y + 5} />
            <line x1={x(Math.max(0, s.mean - sd))} x2={x(Math.max(0, s.mean - sd))} y1={y + 1} y2={y + 9} />
            <line x1={x(s.mean + sd)} x2={x(s.mean + sd)} y1={y + 1} y2={y + 9} />
          </g>
        )}
        {s.values.slice(0, 400).map((v, i) => (
          <circle key={i} cx={x(v)} cy={y + 5} r={2} fill="var(--m-panel)" stroke={color} strokeWidth={1}>
            <title>{`${fmt(v, s.unit)} (measurement ${i + 1} of ${s.values.length})`}</title>
          </circle>
        ))}
      </g>
    );
  };
  const verdictCls = row.verdict === "faster" ? "ok" : row.verdict === "slower" ? "bad" : row.verdict === "within noise" ? "" : "warn";
  return (
    <div className="bm-row">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b className="mono" style={{ fontSize: 12 }}>{row.name}</b>
        <span className="row">
          {row.deltaPct !== null && <span className="mono" style={{ fontSize: 12 }}>{row.deltaPct >= 0 ? "+" : ""}{row.deltaPct.toFixed(1)}%</span>}
          <span className={`tag ${verdictCls}`}>{row.verdict === "faster" ? "▼ faster" : row.verdict === "slower" ? "▲ slower" : row.verdict === "within noise" ? "≈ within noise" : row.verdict}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${row.name}: baseline vs after`}>
        <defs>
          <pattern id="bm-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={SERIES.base} strokeWidth="2" />
          </pattern>
        </defs>
        {bar(row.base, 8, SERIES.base, true)}
        {bar(row.after, 32, SERIES.after, false)}
      </svg>
      <div className="row faint" style={{ fontSize: 11, gap: 14 }}>
        {row.base && <span><span className="bm-swatch" style={{ background: SERIES.base }} /> baseline {fmt(row.base.mean, row.base.unit)}{row.base.stddev != null ? ` ± ${fmt(row.base.stddev, row.base.unit)}` : ""} · n={row.base.n}</span>}
        {row.after && <span><span className="bm-swatch" style={{ background: SERIES.after }} /> after {fmt(row.after.mean, row.after.unit)}{row.after.stddev != null ? ` ± ${fmt(row.after.stddev, row.after.unit)}` : ""} · n={row.after.n}</span>}
        {row.significant === null && row.base && row.after && <span className="tag warn">variance unknown on one side</span>}
      </div>
    </div>
  );
}

export function BenchmarkPanel() {
  const s = useActiveSession();
  const { events } = useUi();
  const [detection, setDetection] = useState<BenchDetection | null>(null);
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [baseline, setBaseline] = useState<string>("");
  const [after, setAfter] = useState<string>("");
  const [cmp, setCmp] = useState<BenchComparison | null>(null);
  const [command, setCommand] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"chart" | "table">("chart");

  const list = s ? events[s.id] ?? [] : [];
  const lastBench = [...list].reverse().find((e) => e.event === "benchmark");

  const load = () => {
    if (!s) return;
    api.benchmarks(s.id).then((r) => { setDetection(r.detection); setRuns(r.runs); }).catch((e) => store.toast(e.message));
  };
  useEffect(() => {
    setDetection(null);
    setRuns([]);
    setCmp(null);
    load();
  }, [s?.id]);
  useEffect(() => {
    if (lastBench) load();
  }, [lastBench?.seq]);
  useEffect(() => {
    if (!s || !baseline || !after || baseline === after) return setCmp(null);
    api.compareBenchmarks(s.id, baseline, after).then((r) => setCmp(r.comparison)).catch((e) => store.toast(e.message));
  }, [s?.id, baseline, after, runs.length]);
  useEffect(() => {
    // sensible defaults: oldest run as baseline, newest as after
    if (runs.length >= 2) {
      if (!baseline || !runs.some((r) => r.id === baseline)) setBaseline(runs[runs.length - 1].id);
      if (!after || !runs.some((r) => r.id === after)) setAfter(runs[0].id);
    }
  }, [runs.length]);

  // Hooks must all run before any early return (a session can appear after mount).
  const max = useMemo(() => {
    let m = 0;
    for (const r of cmp?.rows ?? []) for (const x of [r.base, r.after]) if (x) m = Math.max(m, x.mean + (x.stddev ?? 0), ...(x.values.length ? [Math.max(...x.values)] : []));
    return m || 1;
  }, [cmp]);

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;

  const run = async (cmd: string, lbl?: string) => {
    setBusy(true);
    try {
      await api.runBenchmark(s.id, { command: cmd, label: lbl || label || undefined });
      setCommand("");
      setLabel("");
      load();
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Benchmark</h2>
      <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>Performance sessions only. Distributions, not single numbers: bars are means, whiskers ±1 sd, dots are the individual measurements.</div>

      <h3>Project tooling</h3>
      {!detection && <div className="empty">Detecting…</div>}
      {detection && detection.candidates.length === 0 && <div className="muted">{detection.notes[0]}</div>}
      {detection?.candidates.map((c) => (
        <div key={c.id} className="row" style={{ fontSize: 12, marginBottom: 4 }}>
          <span className="tag">{c.tool}</span>
          <code className="grow">{c.command}</code>
          <button className="btn sm" disabled={busy} onClick={() => run(c.command)}>{busy ? "…" : "Run"}</button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="or the project's documented benchmark command" style={{ flex: 2 }} />
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label: baseline / after fix" style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={busy || !command.trim()} onClick={() => run(command.trim())}>Run</button>
      </div>
      {detection?.notes.slice(detection.candidates.length ? 0 : 1).map((n, i) => <div key={i} className="faint" style={{ fontSize: 11 }}>{n}</div>)}

      <h3>Saved runs ({runs.length})</h3>
      {runs.length === 0 && <div className="empty">No runs yet. The Phase 3 baseline is the first one.</div>}
      {runs.map((r) => (
        <div key={r.id} className="row" style={{ fontSize: 12, marginBottom: 3 }}>
          <input type="radio" name="bm-base" checked={baseline === r.id} onChange={() => setBaseline(r.id)} title="baseline" />
          <input type="radio" name="bm-after" checked={after === r.id} onChange={() => setAfter(r.id)} title="after" />
          <input type="text" defaultValue={r.label} onBlur={(e) => e.target.value !== r.label && api.relabelBenchmark(s.id, r.id, e.target.value).then(load).catch((er) => store.toast(er.message))} style={{ width: 150 }} />
          <span className={`tag ${r.status === "passed" ? "ok" : "bad"}`}>{r.status}</span>
          <span className="faint">{new Date(r.ranAt).toLocaleString()} · {r.tool} · {r.samples.length} benchmark{r.samples.length === 1 ? "" : "s"}</span>
        </div>
      ))}
      {runs.length > 0 && <div className="faint" style={{ fontSize: 11 }}>first radio = baseline, second = after</div>}

      {cmp && (
        <>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
            <h3 style={{ margin: 0 }}>Baseline “{cmp.baseline.label}” → after “{cmp.after.label}”</h3>
            <span className="tag" style={{ cursor: "pointer" }} onClick={() => setView(view === "chart" ? "table" : "chart")}>{view === "chart" ? "table view" : "chart view"}</span>
          </div>
          <div className="row faint" style={{ fontSize: 11, gap: 14, margin: "4px 0 8px" }}>
            <span><span className="bm-swatch hatched" /> baseline</span>
            <span><span className="bm-swatch" style={{ background: SERIES.after }} /> after</span>
            <span>whisker = ±1 sd · dot = one measurement</span>
          </div>
          {view === "chart" ? (
            cmp.rows.map((row) => <Row key={row.name} row={row} max={max} />)
          ) : (
            <table className="tri-matrix">
              <thead><tr><th>benchmark</th><th>baseline mean ± sd (n)</th><th>after mean ± sd (n)</th><th>Δ</th><th>verdict</th></tr></thead>
              <tbody>
                {cmp.rows.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td>{r.base ? `${fmt(r.base.mean, r.base.unit)}${r.base.stddev != null ? ` ± ${fmt(r.base.stddev, r.base.unit)}` : ""} (${r.base.n})` : "—"}</td>
                    <td>{r.after ? `${fmt(r.after.mean, r.after.unit)}${r.after.stddev != null ? ` ± ${fmt(r.after.stddev, r.after.unit)}` : ""} (${r.after.n})` : "—"}</td>
                    <td>{r.deltaPct !== null ? `${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(1)}%` : "—"}</td>
                    <td>{r.verdict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            warm-up: {[...new Set(cmp.rows.flatMap((r) => [r.base?.warmup, r.after?.warmup]).filter(Boolean))].join(" · ") || "not reported by the tool"}. Same hardware, same workload, both warmed up: check all three before quoting a result.
          </div>
        </>
      )}
      {runs.length >= 2 && !cmp && <div className="faint" style={{ fontSize: 11 }}>Pick a baseline and an after run to compare.</div>}
    </div>
  );
}
