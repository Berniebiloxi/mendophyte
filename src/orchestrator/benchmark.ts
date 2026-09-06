import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runVerification } from "./verification/run.js";
import type { GuardrailRule } from "./guardrails.js";

/**
 * Benchmarks for performance sessions (Phase 3 baseline, Phase 4 step 7):
 * run the project's OWN benchmark tool and keep the distribution, not a
 * single number. Runs are persisted under <artifactHome>/benchmarks so the
 * Phase 3 baseline survives to be compared against the Phase 4 result.
 *
 * Parsers: criterion (Rust), `go test -bench`, pytest-benchmark JSON,
 * hyperfine JSON. Anything else runs and is logged but yields no samples.
 */

export type BenchTool = "criterion" | "go-bench" | "pytest-benchmark" | "hyperfine" | "unknown";

export interface BenchSample {
  name: string;
  /** Unit of `mean`/`values`: nanoseconds per operation for time-based tools. */
  unit: "ns" | "ops/s" | "bytes" | "allocs";
  mean: number;
  median: number | null;
  stddev: number | null;
  min: number | null;
  max: number | null;
  /** Individual measurements when the tool exposes them (per-iteration time, per-run wall time). */
  values: number[];
  /** Number of measurements the statistics are based on. */
  n: number;
  /** What the tool says about warm-up, verbatim-ish; null when the tool reports nothing. */
  warmup: string | null;
}

export interface BenchRun {
  id: string;
  ranAt: string;
  label: string;
  command: string;
  tool: BenchTool;
  cwd: string;
  exitCode: number | null;
  status: string;
  durationMs: number;
  logPath: string | null;
  samples: BenchSample[];
  notes: string[];
}

export interface BenchCandidate {
  id: string;
  tool: BenchTool;
  command: string;
  source: string;
  cwd?: string;
}

export interface BenchDetection {
  repoDir: string;
  candidates: BenchCandidate[];
  notes: string[];
}

export interface BenchComparison {
  baseline: { id: string; label: string; ranAt: string };
  after: { id: string; label: string; ranAt: string };
  rows: {
    name: string;
    unit: BenchSample["unit"];
    base: BenchSample | null;
    after: BenchSample | null;
    /** (after - base) / base, negative is faster for time units. */
    deltaPct: number | null;
    /** true when |Δmean| exceeds 2·√(sd_a² + sd_b²); null when either sd is unknown. */
    significant: boolean | null;
    verdict: "faster" | "slower" | "within noise" | "unknown" | "only in baseline" | "only in after";
  }[];
}

const T_RUN = 60 * 60 * 1000;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---- detection -------------------------------------------------------------

export async function detectBenchmarks(repoDir: string): Promise<BenchDetection> {
  const out: BenchDetection = { repoDir, candidates: [], notes: [] };
  if (await exists(path.join(repoDir, "Cargo.toml"))) {
    const hasBenches = await exists(path.join(repoDir, "benches"));
    let criterion = false;
    try {
      criterion = /criterion/i.test(await readFile(path.join(repoDir, "Cargo.toml"), "utf8"));
    } catch {
      /* ignore */
    }
    if (hasBenches || criterion) {
      out.candidates.push({ id: "cargo:bench", tool: criterion ? "criterion" : "unknown", command: "cargo bench", source: `${hasBenches ? "benches/ directory" : "Cargo.toml"}${criterion ? " + criterion dependency" : ""}` });
      if (!criterion) out.notes.push("benches/ exists but criterion is not a dependency; output will be logged but not parsed.");
    }
  }
  if (await exists(path.join(repoDir, "go.mod"))) {
    out.candidates.push({ id: "go:bench", tool: "go-bench", command: "go test -run '^$' -bench . -benchmem -count 5 ./...", source: "go.mod (go's built-in benchmark runner; -count 5 gives a distribution)" });
  }
  const py = (await exists(path.join(repoDir, "pyproject.toml"))) || (await exists(path.join(repoDir, "setup.cfg")));
  if (py) {
    let cfg = "";
    try {
      cfg = (await readFile(path.join(repoDir, "pyproject.toml"), "utf8").catch(() => "")) + (await readFile(path.join(repoDir, "setup.cfg"), "utf8").catch(() => ""));
    } catch {
      /* ignore */
    }
    if (/pytest-benchmark|benchmark/i.test(cfg) || (await exists(path.join(repoDir, "benchmarks")))) {
      out.candidates.push({ id: "py:pytest-benchmark", tool: "pytest-benchmark", command: "python -m pytest --benchmark-only", source: /pytest-benchmark/i.test(cfg) ? "pytest-benchmark in project config" : "benchmarks/ directory" });
    }
  }
  try {
    const pkg = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf8"));
    for (const name of Object.keys(pkg.scripts ?? {})) {
      if (/^(bench|benchmark|benchmarks|perf)(:.*)?$/i.test(name)) out.candidates.push({ id: `npm:${name}`, tool: "unknown", command: `npm run ${name}`, source: `package.json scripts.${name} = "${String(pkg.scripts[name]).slice(0, 80)}"` });
    }
  } catch {
    /* no package.json */
  }
  for (const dir of ["benchmarks", "benchmark", "bench", "perf"]) {
    if (await exists(path.join(repoDir, dir))) out.notes.push(`${dir}/ directory present; see its README or scripts for the project's own methodology.`);
  }
  if (!out.candidates.length) out.notes.push("No benchmark tooling detected. Per 04-fix.md step 7, say so explicitly and propose the simplest reasonable approach for this language rather than assuming one exists.");
  return out;
}

// ---- parsers -----------------------------------------------------------------

function stats(values: number[]): { mean: number; median: number; stddev: number | null; min: number; max: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const stddev = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null;
  return { mean, median, stddev, min: sorted[0], max: sorted[n - 1] };
}

const GO_UNIT_NS: Record<string, number> = { "ns/op": 1, "µs/op": 1e3, "us/op": 1e3, "ms/op": 1e6, "s/op": 1e9 };

/** `go test -bench` text: repeated lines per benchmark (with -count) become a distribution. */
export function parseGoBench(text: string): BenchSample[] {
  const per = new Map<string, number[]>();
  const mem = new Map<string, { bytes: number[]; allocs: number[] }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(Benchmark\S+?)(?:-\d+)?\s+(\d+)\s+([\d.]+)\s+(ns\/op|µs\/op|us\/op|ms\/op|s\/op)(.*)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1];
    const ns = parseFloat(m[3]) * GO_UNIT_NS[m[4]];
    per.set(name, [...(per.get(name) ?? []), ns]);
    const b = /([\d.]+)\s+B\/op/.exec(m[5]);
    const a = /([\d.]+)\s+allocs\/op/.exec(m[5]);
    if (b || a) {
      const cur = mem.get(name) ?? { bytes: [], allocs: [] };
      if (b) cur.bytes.push(parseFloat(b[1]));
      if (a) cur.allocs.push(parseFloat(a[1]));
      mem.set(name, cur);
    }
  }
  const out: BenchSample[] = [];
  for (const [name, values] of per) {
    const s = stats(values);
    out.push({ name, unit: "ns", mean: s.mean, median: s.median, stddev: s.stddev, min: s.min, max: s.max, values, n: values.length, warmup: "go's runner calibrates iteration count before timing (built-in warm-up)" });
    const m = mem.get(name);
    if (m?.bytes.length) {
      const bs = stats(m.bytes);
      out.push({ name: `${name} (B/op)`, unit: "bytes", mean: bs.mean, median: bs.median, stddev: bs.stddev, min: bs.min, max: bs.max, values: m.bytes, n: m.bytes.length, warmup: null });
    }
  }
  return out;
}

/** pytest-benchmark `--benchmark-json` output. */
export function parsePytestBenchmark(json: any): BenchSample[] {
  const out: BenchSample[] = [];
  const warm = json?.machine_info ? null : null;
  void warm;
  for (const b of json?.benchmarks ?? []) {
    const st = b.stats ?? {};
    const toNs = (s: number) => s * 1e9;
    const values: number[] = Array.isArray(st.data) ? st.data.map(toNs) : [];
    const opts = b.options ?? {};
    out.push({
      name: b.fullname ?? b.name ?? "benchmark",
      unit: "ns",
      mean: toNs(st.mean ?? 0),
      median: st.median != null ? toNs(st.median) : null,
      stddev: st.stddev != null ? toNs(st.stddev) : null,
      min: st.min != null ? toNs(st.min) : null,
      max: st.max != null ? toNs(st.max) : null,
      values,
      n: st.rounds ?? values.length,
      warmup: opts.warmup ? `warm-up ${opts.warmup_iterations ?? "?"} iterations` : "no warm-up (pytest-benchmark default)",
    });
  }
  return out;
}

/** hyperfine `--export-json` output. */
export function parseHyperfine(json: any): BenchSample[] {
  const out: BenchSample[] = [];
  for (const r of json?.results ?? []) {
    const toNs = (s: number) => s * 1e9;
    const values: number[] = Array.isArray(r.times) ? r.times.map(toNs) : [];
    out.push({
      name: r.command ?? "command",
      unit: "ns",
      mean: toNs(r.mean ?? 0),
      median: r.median != null ? toNs(r.median) : null,
      stddev: r.stddev != null ? toNs(r.stddev) : null,
      min: r.min != null ? toNs(r.min) : null,
      max: r.max != null ? toNs(r.max) : null,
      values,
      n: values.length || (r.runs ?? 0),
      warmup: "warm-up runs only if --warmup was passed (not recorded in the export)",
    });
  }
  return out;
}

/** criterion writes target/criterion/<group>/<bench>/new/{estimates,sample,benchmark}.json after `cargo bench`. */
export async function readCriterion(repoDir: string, since: number): Promise<BenchSample[]> {
  const root = path.join(repoDir, "target", "criterion");
  const out: BenchSample[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    if (names.includes("new")) {
      const est = path.join(dir, "new", "estimates.json");
      try {
        const st = await stat(est);
        if (st.mtimeMs < since - 1000) return; // stale from a previous run
        const e = JSON.parse(await readFile(est, "utf8"));
        let name = path.relative(root, dir).split(path.sep).join("/");
        try {
          const b = JSON.parse(await readFile(path.join(dir, "new", "benchmark.json"), "utf8"));
          name = b.full_id ?? name;
        } catch {
          /* keep path name */
        }
        let values: number[] = [];
        try {
          const s = JSON.parse(await readFile(path.join(dir, "new", "sample.json"), "utf8"));
          if (Array.isArray(s.iters) && Array.isArray(s.times)) values = s.times.map((t: number, i: number) => t / (s.iters[i] || 1));
        } catch {
          /* no sample */
        }
        out.push({
          name,
          unit: "ns",
          mean: e.mean?.point_estimate ?? 0,
          median: e.median?.point_estimate ?? null,
          stddev: e.std_dev?.point_estimate ?? null,
          min: values.length ? Math.min(...values) : null,
          max: values.length ? Math.max(...values) : null,
          values,
          n: values.length,
          warmup: "criterion warms up before sampling (3 s by default; see the bench's config)",
        });
      } catch {
        /* unreadable */
      }
      return;
    }
    for (const n of names) if (n !== "report") await walk(path.join(dir, n), depth + 1);
  };
  await walk(root, 0);
  return out;
}

// ---- running & storage ------------------------------------------------------

function runsDir(artifactHome: string): string {
  return path.join(artifactHome, "benchmarks");
}

export async function listBenchRuns(artifactHome: string): Promise<BenchRun[]> {
  const dir = runsDir(artifactHome);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const runs: BenchRun[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      runs.push(JSON.parse(await readFile(path.join(dir, n), "utf8")));
    } catch {
      /* skip corrupt */
    }
  }
  return runs.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
}

export async function getBenchRun(artifactHome: string, id: string): Promise<BenchRun | null> {
  try {
    return JSON.parse(await readFile(path.join(runsDir(artifactHome), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function relabelBenchRun(artifactHome: string, id: string, label: string): Promise<BenchRun | null> {
  const run = await getBenchRun(artifactHome, id);
  if (!run) return null;
  run.label = label.trim().slice(0, 80) || run.label;
  await writeFile(path.join(runsDir(artifactHome), `${id}.json`), JSON.stringify(run, null, 2));
  return run;
}

export interface RunBenchOptions {
  repoDir: string;
  artifactHome: string;
  command: string;
  label?: string;
  tool?: BenchTool;
  cwd?: string;
  timeoutMs?: number;
  guardrails?: GuardrailRule[];
}

export function guessTool(command: string): BenchTool {
  if (/\bcargo\s+(criterion|bench)\b/.test(command)) return "criterion";
  if (/\bgo\s+test\b.*-bench/.test(command)) return "go-bench";
  if (/pytest\b.*benchmark|--benchmark/.test(command)) return "pytest-benchmark";
  if (/\bhyperfine\b/.test(command)) return "hyperfine";
  return "unknown";
}

/** Runs one benchmark command, parses what it can, persists the run, returns it. */
export async function runBenchmark(opts: RunBenchOptions): Promise<BenchRun> {
  const id = randomUUID();
  const dir = runsDir(opts.artifactHome);
  await mkdir(dir, { recursive: true });
  const tool = opts.tool ?? guessTool(opts.command);
  const notes: string[] = [];
  let command = opts.command;
  const exportPath = path.join(dir, `${id}-export.json`);
  if (tool === "pytest-benchmark" && !/--benchmark-json/.test(command)) {
    command += ` --benchmark-json="${exportPath}"`;
    notes.push("added --benchmark-json so results can be parsed");
  }
  if (tool === "hyperfine" && !/--export-json/.test(command)) {
    command += ` --export-json "${exportPath}"`;
    notes.push("added --export-json so results can be parsed");
  }
  const started = Date.now();
  const v = await runVerification({
    repoDir: opts.repoDir,
    artifactHome: opts.artifactHome,
    checks: [{ id: "benchmark", kind: "other", command, cwd: opts.cwd, source: "benchmark run" }],
    timeoutMs: opts.timeoutMs ?? T_RUN,
    guardrails: opts.guardrails,
  });
  const r = v.results[0];
  let samples: BenchSample[] = [];
  try {
    if (r.status === "passed" || r.status === "failed") {
      if (tool === "go-bench") samples = parseGoBench(r.logPath ? await readFile(r.logPath, "utf8") : r.outputTail);
      else if (tool === "criterion") samples = await readCriterion(path.resolve(opts.repoDir, opts.cwd ?? "."), started);
      else if (tool === "pytest-benchmark" || tool === "hyperfine") {
        const m = /--(?:benchmark-json|export-json)[= ]"?([^"\s]+)"?/.exec(command);
        const p = m ? path.resolve(opts.repoDir, opts.cwd ?? ".", m[1]) : exportPath;
        const json = JSON.parse(await readFile(p, "utf8"));
        samples = tool === "hyperfine" ? parseHyperfine(json) : parsePytestBenchmark(json);
      }
    }
  } catch (e) {
    notes.push(`could not parse results: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (r.status === "refused") notes.push(r.reason ?? "refused");
  if (tool === "unknown") notes.push("unrecognised benchmark tool: the run is logged, but no samples were parsed; paste the numbers or use a supported tool");
  if (!samples.length && (r.status === "passed" || r.status === "failed") && tool !== "unknown") notes.push("no samples parsed; check the log");
  if (samples.some((s) => s.n < 5)) notes.push("fewer than 5 measurements for at least one benchmark: variance is not meaningful yet (04-fix.md step 7: run enough repetitions)");

  const run: BenchRun = {
    id,
    ranAt: new Date(started).toISOString(),
    label: (opts.label ?? "").trim().slice(0, 80) || `run ${new Date(started).toISOString().slice(11, 19)}`,
    command,
    tool,
    cwd: r.cwd,
    exitCode: r.exitCode,
    status: r.status,
    durationMs: r.durationMs,
    logPath: r.logPath,
    samples,
    notes,
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(run, null, 2));
  return run;
}

// ---- comparison ---------------------------------------------------------------

export function compareRuns(baseline: BenchRun, after: BenchRun): BenchComparison {
  const names = new Set([...baseline.samples.map((s) => s.name), ...after.samples.map((s) => s.name)]);
  const rows: BenchComparison["rows"] = [];
  for (const name of names) {
    const b = baseline.samples.find((s) => s.name === name) ?? null;
    const a = after.samples.find((s) => s.name === name) ?? null;
    if (!b || !a) {
      rows.push({ name, unit: (b ?? a)!.unit, base: b, after: a, deltaPct: null, significant: null, verdict: b ? "only in baseline" : "only in after" });
      continue;
    }
    const deltaPct = b.mean ? ((a.mean - b.mean) / b.mean) * 100 : null;
    let significant: boolean | null = null;
    if (b.stddev != null && a.stddev != null && b.n > 1 && a.n > 1) significant = Math.abs(a.mean - b.mean) > 2 * Math.sqrt(b.stddev ** 2 + a.stddev ** 2);
    const lowerIsBetter = b.unit === "ns" || b.unit === "bytes" || b.unit === "allocs";
    let verdict: BenchComparison["rows"][number]["verdict"] = "unknown";
    if (deltaPct !== null) {
      if (significant === false) verdict = "within noise";
      else if (significant === true) verdict = (deltaPct < 0) === lowerIsBetter ? "faster" : "slower";
      else verdict = "unknown";
    }
    rows.push({ name, unit: b.unit, base: b, after: a, deltaPct, significant, verdict });
  }
  return { baseline: { id: baseline.id, label: baseline.label, ranAt: baseline.ranAt }, after: { id: after.id, label: after.label, ranAt: after.ranAt }, rows };
}

export function fmtNs(ns: number): string {
  if (!Number.isFinite(ns)) return "?";
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(3)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(3)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(1)} ns`;
}

function fmtVal(s: BenchSample): string {
  const v = s.unit === "ns" ? fmtNs(s.mean) : `${s.mean.toFixed(1)} ${s.unit}`;
  const sd = s.stddev != null ? ` ± ${s.unit === "ns" ? fmtNs(s.stddev) : s.stddev.toFixed(1)} sd` : " (sd unknown)";
  return `${v}${sd}, n=${s.n}`;
}

export function formatBenchRun(run: BenchRun): string {
  const L = [`## Benchmark run ${run.id.slice(0, 8)} "${run.label}" (${run.tool}), ${run.ranAt}`, `Command: \`${run.command}\` in ${run.cwd}; exit ${run.exitCode ?? "null"} (${run.status}), ${(run.durationMs / 1000).toFixed(1)}s${run.logPath ? `; log ${run.logPath}` : ""}`];
  if (!run.samples.length) L.push("- no samples parsed");
  for (const s of run.samples) L.push(`- ${s.name}: mean ${fmtVal(s)}${s.median != null ? `, median ${s.unit === "ns" ? fmtNs(s.median) : s.median.toFixed(1)}` : ""}${s.min != null && s.max != null ? `, range ${s.unit === "ns" ? `${fmtNs(s.min)}–${fmtNs(s.max)}` : `${s.min.toFixed(1)}–${s.max.toFixed(1)}`}` : ""}${s.warmup ? `; warm-up: ${s.warmup}` : ""}`);
  for (const n of run.notes) L.push(`- note: ${n}`);
  L.push("Report mean with its spread and n, never the mean alone; a single run is not a baseline.");
  return L.join("\n");
}

export function formatComparison(c: BenchComparison): string {
  const L = [`## Benchmark comparison: "${c.baseline.label}" (${c.baseline.ranAt}) → "${c.after.label}" (${c.after.ranAt})`];
  for (const r of c.rows) {
    if (!r.base || !r.after) {
      L.push(`- ${r.name}: ${r.verdict}`);
      continue;
    }
    L.push(`- ${r.name}: ${fmtVal(r.base)} → ${fmtVal(r.after)}; Δ ${r.deltaPct! >= 0 ? "+" : ""}${r.deltaPct!.toFixed(1)}%; ${r.verdict}${r.significant === null ? " (variance unknown for at least one side; run more repetitions)" : r.significant ? " (|Δ| > 2·√(sd₁²+sd₂²))" : " (|Δ| ≤ 2·√(sd₁²+sd₂²))"}`);
  }
  L.push("Same hardware, same workload, both runs warmed up: check all three before quoting any of this.");
  return L.join("\n");
}

export function formatBenchDetection(d: BenchDetection): string {
  const L = ["## Benchmark tooling detected by Mendophyte"];
  if (!d.candidates.length) L.push("- none detected");
  for (const c of d.candidates) L.push(`- \`${c.id}\` (${c.tool}): \`${c.command}\`; source: ${c.source}`);
  for (const n of d.notes) L.push(`- note: ${n}`);
  return L.join("\n");
}
