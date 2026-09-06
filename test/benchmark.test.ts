import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { compareRuns, detectBenchmarks, formatComparison, formatBenchRun, guessTool, listBenchRuns, parseGoBench, parseHyperfine, parsePytestBenchmark, readCriterion, relabelBenchRun, runBenchmark } from "../src/orchestrator/benchmark.js";

test("benchmark: go bench text with -count becomes a distribution, memory stats split out", () => {
  const text = [
    "goos: linux",
    "BenchmarkParse-8   \t 1000000\t      1200 ns/op\t     128 B/op\t       2 allocs/op",
    "BenchmarkParse-8   \t 1000000\t      1250 ns/op\t     128 B/op\t       2 allocs/op",
    "BenchmarkParse-8   \t 1000000\t      1180 ns/op\t     128 B/op\t       2 allocs/op",
    "BenchmarkLex-8     \t 5000000\t       0.85 µs/op",
    "PASS",
  ].join("\n");
  const s = parseGoBench(text);
  const parse = s.find((x) => x.name === "BenchmarkParse")!;
  assert.equal(parse.n, 3);
  assert.equal(parse.unit, "ns");
  assert.ok(Math.abs(parse.mean - 1210) < 1e-6);
  assert.ok(parse.stddev! > 30 && parse.stddev! < 40);
  assert.deepEqual(parse.values, [1200, 1250, 1180]);
  assert.match(parse.warmup ?? "", /calibrates/);
  const mem = s.find((x) => x.name === "BenchmarkParse (B/op)")!;
  assert.equal(mem.unit, "bytes");
  assert.equal(mem.mean, 128);
  const lex = s.find((x) => x.name === "BenchmarkLex")!;
  assert.equal(lex.mean, 850, "µs converted to ns");
  assert.equal(lex.stddev, null, "single measurement has no spread");
});

test("benchmark: pytest-benchmark and hyperfine JSON are normalised to nanoseconds with samples", () => {
  const py = parsePytestBenchmark({ benchmarks: [{ fullname: "tests/test_x.py::test_parse", stats: { mean: 0.0012, stddev: 0.0001, median: 0.00118, min: 0.001, max: 0.0015, rounds: 4, data: [0.001, 0.0011, 0.0013, 0.0015] }, options: { warmup: true, warmup_iterations: 100000 } }] });
  assert.equal(py.length, 1);
  assert.equal(py[0].mean, 1.2e6);
  assert.equal(py[0].n, 4);
  assert.equal(py[0].values.length, 4);
  assert.match(py[0].warmup ?? "", /warm-up 100000/);

  const hf = parseHyperfine({ results: [{ command: "./tool input.txt", mean: 0.5, stddev: 0.02, median: 0.49, min: 0.47, max: 0.55, times: [0.47, 0.5, 0.55, 0.48] }] });
  assert.equal(hf[0].name, "./tool input.txt");
  assert.equal(hf[0].mean, 5e8);
  assert.equal(hf[0].n, 4);
});

test("benchmark: criterion output directory is read, stale results ignored", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "mendophyte-crit-"));
  try {
    const d = path.join(repo, "target", "criterion", "lexer", "unicode", "new");
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, "estimates.json"), JSON.stringify({ mean: { point_estimate: 1500 }, median: { point_estimate: 1480 }, std_dev: { point_estimate: 40 } }));
    await writeFile(path.join(d, "benchmark.json"), JSON.stringify({ full_id: "lexer/unicode" }));
    await writeFile(path.join(d, "sample.json"), JSON.stringify({ iters: [100, 100, 100], times: [150000, 148000, 152000] }));
    const s = await readCriterion(repo, Date.now() - 60_000);
    assert.equal(s.length, 1);
    assert.equal(s[0].name, "lexer/unicode");
    assert.equal(s[0].mean, 1500);
    assert.deepEqual(s[0].values, [1500, 1480, 1520]);
    assert.equal(s[0].n, 3);
    const stale = await readCriterion(repo, Date.now() + 60_000);
    assert.equal(stale.length, 0, "results older than the run start are not attributed to it");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("benchmark: detection, tool guessing", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "mendophyte-bd-"));
  try {
    await writeFile(path.join(repo, "Cargo.toml"), "[package]\nname='x'\n[dev-dependencies]\ncriterion = '0.5'\n");
    await mkdir(path.join(repo, "benches"));
    await writeFile(path.join(repo, "go.mod"), "module x\n");
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { bench: "node bench.js", "bench:parse": "node bench.js parse" } }));
    const d = await detectBenchmarks(repo);
    const ids = d.candidates.map((c) => c.id);
    assert.deepEqual(ids, ["cargo:bench", "go:bench", "npm:bench", "npm:bench:parse"]);
    assert.equal(d.candidates[0].tool, "criterion");
    assert.equal(guessTool("cargo bench --bench lexer"), "criterion");
    assert.equal(guessTool("go test -bench=. ./..."), "go-bench");
    assert.equal(guessTool("hyperfine './a' './b'"), "hyperfine");
    assert.equal(guessTool("python -m pytest --benchmark-only"), "pytest-benchmark");
    assert.equal(guessTool("npm run bench"), "unknown");
    const empty = await detectBenchmarks(await mkdtemp(path.join(os.tmpdir(), "mendophyte-bd2-")));
    assert.equal(empty.candidates.length, 0);
    assert.match(empty.notes[0], /No benchmark tooling detected/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("benchmark: run persists, compares, and states significance honestly", { timeout: 60_000 }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mendophyte-br-"));
  const repoDir = path.join(base, "repo");
  const artifactHome = path.join(base, "art");
  await mkdir(repoDir);
  try {
    const node = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
    const cmd = (vals: number[]) => `${node} -e "for (const v of [${vals.join(",")}]) console.log('BenchmarkX-8 1000 '+v+' ns/op')"`;
    const b = await runBenchmark({ repoDir, artifactHome, command: cmd([1000, 1010, 990, 1005, 995]), label: "baseline", tool: "go-bench" });
    assert.equal(b.status, "passed");
    assert.equal(b.samples.length, 1);
    assert.equal(b.samples[0].n, 5);
    assert.ok(b.logPath);
    const a = await runBenchmark({ repoDir, artifactHome, command: cmd([800, 810, 790, 805, 795]), label: "after", tool: "go-bench" });
    const noisy = await runBenchmark({ repoDir, artifactHome, command: cmd([1000, 900, 1100, 1050, 950]), label: "noisy", tool: "go-bench" });
    const single = await runBenchmark({ repoDir, artifactHome, command: cmd([700]), label: "single", tool: "go-bench" });
    assert.match(single.notes.join(" "), /fewer than 5 measurements/);

    const runs = await listBenchRuns(artifactHome);
    assert.equal(runs.length, 4);
    assert.equal(runs[0].label, "single", "newest first");
    const relabelled = await relabelBenchRun(artifactHome, single.id, "single run");
    assert.equal(relabelled?.label, "single run");

    const c1 = compareRuns(b, a);
    assert.equal(c1.rows[0].verdict, "faster");
    assert.equal(c1.rows[0].significant, true);
    assert.ok(c1.rows[0].deltaPct! < -19 && c1.rows[0].deltaPct! > -21);
    const c2 = compareRuns(b, noisy);
    assert.equal(c2.rows[0].verdict, "within noise");
    const c3 = compareRuns(b, single);
    assert.equal(c3.rows[0].significant, null);
    assert.equal(c3.rows[0].verdict, "unknown");

    const text = formatComparison(c1);
    assert.match(text, /faster \(\|Δ\| > 2·√/);
    assert.match(formatBenchRun(b), /mean 1\.00 µs ± \d+\.\d ns sd, n=5/);

    const refused = await runBenchmark({ repoDir, artifactHome, command: "git push --force", label: "sneaky" });
    assert.equal(refused.status, "refused");
    assert.match(refused.notes.join(" "), /guardrail/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
