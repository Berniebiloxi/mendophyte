import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "../preflight/run.js";

/**
 * Detects the project's OWN verification commands from machine-readable
 * config, which Phase 4's convention hierarchy ranks first. Everything
 * returned cites where it came from. Nothing here runs a check; see run.ts.
 *
 * Also gathers what Phase 5E needs: toolchain pins versus what is active
 * locally, and the literal `run:` steps CI executes.
 */

export type CheckKind = "format" | "lint" | "typecheck" | "test" | "build" | "ci-local" | "other";

export interface VerificationCheck {
  /** Stable id, e.g. `npm:test`, `cargo:clippy`. */
  id: string;
  kind: CheckKind;
  command: string;
  /** Relative to the repo root; omitted means the root. */
  cwd?: string;
  /** Where this command was detected, for citation. */
  source: string;
  /** How success is judged. Default exit-zero. `no-output` for gofmt -l style tools. */
  successRule?: "exit-zero" | "no-output";
  /** True when the command is expected to rewrite files (formatters without --check). */
  mayModify?: boolean;
  /** True for heavy or environment-wide runners (tox, nox, pre-commit) not run by default. */
  heavy?: boolean;
}

export interface ToolchainPin {
  tool: string;
  pinned: string;
  source: string;
  local: string | null;
  localSource: string;
}

export interface CiStep {
  file: string;
  run: string;
}

export interface DetectionReport {
  repoDir: string;
  subpath: string | null;
  checks: VerificationCheck[];
  toolchain: ToolchainPin[];
  ciSteps: CiStep[];
  /** Manifests that were looked for and found. */
  manifests: string[];
  notes: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

const rel = (sub: string | null, f: string) => (sub ? `${sub}/${f}` : f);

async function detectNode(root: string, sub: string | null, out: DetectionReport): Promise<void> {
  const pkgPath = path.join(root, "package.json");
  const raw = await readText(pkgPath);
  if (!raw) return;
  out.manifests.push(rel(sub, "package.json"));
  let pkg: any;
  try {
    pkg = JSON.parse(raw);
  } catch {
    out.notes.push(`${rel(sub, "package.json")} is not valid JSON; scripts not read.`);
    return;
  }
  const pm = (await exists(path.join(root, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(path.join(root, "yarn.lock")))
      ? "yarn"
      : (await exists(path.join(root, "bun.lockb"))) || (await exists(path.join(root, "bun.lock")))
        ? "bun"
        : "npm";
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const cwd = sub ?? undefined;
  const src = (name: string) => `${rel(sub, "package.json")} scripts.${name}`;
  const runCmd = (name: string) => (pm === "npm" && name === "test" ? "npm test" : `${pm} run ${name}`);

  const classify = (name: string, body: string): { kind: CheckKind; mayModify?: boolean } | null => {
    const n = name.toLowerCase();
    if (/^(test|tests|unit|spec|jest|vitest|mocha|ava)$/.test(n) || /^test:(unit|all|ci)$/.test(n)) return { kind: "test" };
    if (/^(lint|eslint|biome:lint|check:lint)$/.test(n)) return { kind: "lint", mayModify: /--fix\b|--write\b/.test(body) };
    if (/^(typecheck|type-check|types|tsc|check:types|check-types)$/.test(n)) return { kind: "typecheck" };
    if (/^(format:check|fmt:check|prettier:check|check:format|check:fmt|format-check|lint:format)$/.test(n)) return { kind: "format" };
    if (/^(format|fmt|prettier|biome:format)$/.test(n)) {
      const writes = /--write\b|-w\b|--fix\b/.test(body) || !/--check\b|--list-different\b|-l\b/.test(body);
      return { kind: "format", mayModify: writes };
    }
    if (/^(build|compile)$/.test(n)) return { kind: "build" };
    if (/^(check|ci|verify|validate)$/.test(n)) return { kind: "ci-local" };
    return null;
  };
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== "string") continue;
    const c = classify(name, body);
    if (!c) continue;
    out.checks.push({ id: `${pm}:${name}`, kind: c.kind, command: runCmd(name), cwd, source: `${src(name)} = "${body.slice(0, 120)}"`, mayModify: c.mayModify });
  }
  if (pkg.engines?.node) out.toolchain.push({ tool: "node", pinned: String(pkg.engines.node), source: `${rel(sub, "package.json")} engines.node`, local: null, localSource: "node --version" });
}

async function detectRust(root: string, sub: string | null, out: DetectionReport): Promise<void> {
  if (!(await exists(path.join(root, "Cargo.toml")))) return;
  out.manifests.push(rel(sub, "Cargo.toml"));
  const cwd = sub ?? undefined;
  const source = `${rel(sub, "Cargo.toml")} present (cargo's standard subcommands)`;
  out.checks.push({ id: "cargo:fmt-check", kind: "format", command: "cargo fmt --all -- --check", cwd, source });
  out.checks.push({ id: "cargo:clippy", kind: "lint", command: "cargo clippy --all-targets", cwd, source });
  out.checks.push({ id: "cargo:test", kind: "test", command: "cargo test", cwd, source });
  out.checks.push({ id: "cargo:build", kind: "build", command: "cargo build", cwd, source });
  const tc = (await readText(path.join(root, "rust-toolchain.toml"))) ?? (await readText(path.join(root, "rust-toolchain")));
  if (tc) {
    const m = /channel\s*=\s*"([^"]+)"/.exec(tc) ?? [null, tc.trim().split(/\r?\n/)[0]];
    if (m[1]) out.toolchain.push({ tool: "rust", pinned: m[1], source: rel(sub, "rust-toolchain(.toml)"), local: null, localSource: "rustc --version" });
  }
  if (await exists(path.join(root, "clippy.toml"))) out.notes.push(`${rel(sub, "clippy.toml")} exists: clippy is configured explicitly.`);
  if ((await exists(path.join(root, "rustfmt.toml"))) || (await exists(path.join(root, ".rustfmt.toml")))) out.notes.push(`${rel(sub, "rustfmt.toml")} exists: rustfmt is configured explicitly.`);
}

async function detectGo(root: string, sub: string | null, out: DetectionReport): Promise<void> {
  const gomod = await readText(path.join(root, "go.mod"));
  if (!gomod) return;
  out.manifests.push(rel(sub, "go.mod"));
  const cwd = sub ?? undefined;
  const source = `${rel(sub, "go.mod")} present (go's standard subcommands)`;
  out.checks.push({ id: "go:gofmt", kind: "format", command: "gofmt -l .", cwd, source, successRule: "no-output" });
  out.checks.push({ id: "go:vet", kind: "lint", command: "go vet ./...", cwd, source });
  out.checks.push({ id: "go:test", kind: "test", command: "go test ./...", cwd, source });
  out.checks.push({ id: "go:build", kind: "build", command: "go build ./...", cwd, source });
  if (await exists(path.join(root, ".golangci.yml")) || (await exists(path.join(root, ".golangci.yaml")))) {
    out.checks.push({ id: "go:golangci-lint", kind: "lint", command: "golangci-lint run", cwd, source: `${rel(sub, ".golangci.yml")} present` });
  }
  const gv = /^go\s+(\S+)/m.exec(gomod);
  if (gv) out.toolchain.push({ tool: "go", pinned: gv[1], source: `${rel(sub, "go.mod")} go directive`, local: null, localSource: "go version" });
}

async function detectPython(root: string, sub: string | null, out: DetectionReport): Promise<void> {
  const pyproject = await readText(path.join(root, "pyproject.toml"));
  const setupCfg = await readText(path.join(root, "setup.cfg"));
  const hasSetupPy = await exists(path.join(root, "setup.py"));
  const tox = await exists(path.join(root, "tox.ini"));
  const nox = (await exists(path.join(root, "noxfile.py")));
  if (!pyproject && !setupCfg && !hasSetupPy && !tox && !nox) return;
  const cwd = sub ?? undefined;
  const cfg = (pyproject ?? "") + "\n" + (setupCfg ?? "");
  if (pyproject) out.manifests.push(rel(sub, "pyproject.toml"));
  if (setupCfg) out.manifests.push(rel(sub, "setup.cfg"));
  const has = (re: RegExp) => re.test(cfg);
  const srcOf = pyproject ? rel(sub, "pyproject.toml") : rel(sub, "setup.cfg");

  const testsDir = (await exists(path.join(root, "tests"))) || (await exists(path.join(root, "test")));
  if (has(/\[tool\.pytest/) || has(/\bpytest\b/) || testsDir) {
    out.checks.push({ id: "py:pytest", kind: "test", command: "python -m pytest", cwd, source: has(/\[tool\.pytest/) ? `${srcOf} [tool.pytest]` : has(/\bpytest\b/) ? `${srcOf} mentions pytest` : `${rel(sub, "tests/")} directory present` });
  }
  if (has(/\[tool\.ruff/) || has(/\bruff\b/)) {
    out.checks.push({ id: "py:ruff-check", kind: "lint", command: "ruff check .", cwd, source: `${srcOf} ruff` });
    out.checks.push({ id: "py:ruff-format-check", kind: "format", command: "ruff format --check .", cwd, source: `${srcOf} ruff` });
  }
  if (has(/\[tool\.black/) || has(/\bblack\b/)) out.checks.push({ id: "py:black-check", kind: "format", command: "black --check .", cwd, source: `${srcOf} black` });
  if (has(/\[tool\.isort/) || has(/\bisort\b/)) out.checks.push({ id: "py:isort-check", kind: "format", command: "isort --check-only .", cwd, source: `${srcOf} isort` });
  if (has(/\[flake8\]/) || has(/\bflake8\b/) || (await exists(path.join(root, ".flake8")))) out.checks.push({ id: "py:flake8", kind: "lint", command: "flake8", cwd, source: `${srcOf} / .flake8` });
  if (has(/\[tool\.mypy/) || has(/\bmypy\b/) || (await exists(path.join(root, "mypy.ini")))) out.checks.push({ id: "py:mypy", kind: "typecheck", command: "mypy .", cwd, source: `${srcOf} / mypy.ini` });
  if (has(/\[tool\.pyright/) || has(/\bpyright\b/) || (await exists(path.join(root, "pyrightconfig.json")))) out.checks.push({ id: "py:pyright", kind: "typecheck", command: "pyright", cwd, source: `${srcOf} / pyrightconfig.json` });
  if (tox) out.checks.push({ id: "py:tox", kind: "ci-local", command: "tox", cwd, source: rel(sub, "tox.ini"), heavy: true });
  if (nox) out.checks.push({ id: "py:nox", kind: "ci-local", command: "nox", cwd, source: rel(sub, "noxfile.py"), heavy: true });
  const rp = /requires-python\s*=\s*"([^"]+)"/.exec(cfg);
  if (rp) out.toolchain.push({ tool: "python", pinned: rp[1], source: `${srcOf} requires-python`, local: null, localSource: "python --version" });
}

async function detectMake(root: string, sub: string | null, out: DetectionReport): Promise<void> {
  const mk = (await readText(path.join(root, "Makefile"))) ?? (await readText(path.join(root, "makefile"))) ?? (await readText(path.join(root, "GNUmakefile")));
  if (!mk) return;
  out.manifests.push(rel(sub, "Makefile"));
  const cwd = sub ?? undefined;
  const targets = new Set<string>();
  for (const line of mk.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (m && !m[1].startsWith(".")) targets.add(m[1]);
  }
  const map: [RegExp, CheckKind][] = [
    [/^(test|tests|check-tests|unittest)$/, "test"],
    [/^(lint|clippy|eslint|flake8|ruff)$/, "lint"],
    [/^(fmt-check|format-check|check-fmt|check-format|fmtcheck)$/, "format"],
    [/^(typecheck|type-check|mypy|tsc)$/, "typecheck"],
    [/^(build|all|compile)$/, "build"],
    [/^(check|ci|verify|validate)$/, "ci-local"],
  ];
  for (const t of targets) {
    for (const [re, kind] of map) {
      if (re.test(t)) {
        out.checks.push({ id: `make:${t}`, kind, command: `make ${t}`, cwd, source: `${rel(sub, "Makefile")} target ${t}` });
        break;
      }
    }
    if (/^(fmt|format)$/.test(t)) out.checks.push({ id: `make:${t}`, kind: "format", command: `make ${t}`, cwd, source: `${rel(sub, "Makefile")} target ${t}`, mayModify: true });
  }
}

async function detectPreCommit(root: string, sub: string | null, out: DetectionReport): Promise<void> {
  if (await exists(path.join(root, ".pre-commit-config.yaml"))) {
    out.manifests.push(rel(sub, ".pre-commit-config.yaml"));
    out.checks.push({ id: "pre-commit:all", kind: "lint", command: "pre-commit run --all-files", cwd: sub ?? undefined, source: rel(sub, ".pre-commit-config.yaml"), heavy: true, mayModify: true });
  }
}

async function detectToolchainFiles(root: string, sub: string | null, out: DetectionReport): Promise<void> {
  const nvm = (await readText(path.join(root, ".nvmrc"))) ?? (await readText(path.join(root, ".node-version")));
  if (nvm) out.toolchain.push({ tool: "node", pinned: nvm.trim(), source: rel(sub, ".nvmrc / .node-version"), local: null, localSource: "node --version" });
  const pyv = await readText(path.join(root, ".python-version"));
  if (pyv) out.toolchain.push({ tool: "python", pinned: pyv.trim(), source: rel(sub, ".python-version"), local: null, localSource: "python --version" });
  const tv = await readText(path.join(root, ".tool-versions"));
  if (tv) {
    for (const line of tv.split(/\r?\n/)) {
      const m = /^(\S+)\s+(\S+)/.exec(line.trim());
      if (m) out.toolchain.push({ tool: m[1], pinned: m[2], source: rel(sub, ".tool-versions"), local: null, localSource: `${m[1]} --version` });
    }
  }
}

async function fillLocalVersions(out: DetectionReport): Promise<void> {
  const cache = new Map<string, string | null>();
  const probe = async (tool: string): Promise<string | null> => {
    if (cache.has(tool)) return cache.get(tool)!;
    let r;
    switch (tool) {
      case "node":
      case "nodejs":
        r = await run("node", ["--version"], { timeoutMs: 10_000 });
        break;
      case "python":
        r = await run("python", ["--version"], { timeoutMs: 10_000 });
        if (!r.ok) r = await run("python3", ["--version"], { timeoutMs: 10_000 });
        break;
      case "rust":
        r = await run("rustc", ["--version"], { timeoutMs: 10_000 });
        break;
      case "go":
        r = await run("go", ["version"], { timeoutMs: 10_000 });
        break;
      default:
        r = await run(tool, ["--version"], { timeoutMs: 10_000 });
    }
    const v = r.ok ? (r.stdout || r.stderr).trim().split(/\r?\n/)[0] : null;
    cache.set(tool, v);
    return v;
  };
  for (const t of out.toolchain) t.local = await probe(t.tool);
}

/** Pulls `run:` steps out of GitHub workflow files and `script:` lines from .gitlab-ci.yml without a YAML parser. */
export function extractCiRunSteps(file: string, text: string): CiStep[] {
  const steps: CiStep[] = [];
  const lines = text.split(/\r?\n/);
  const isGitlab = /gitlab-ci\.ya?ml$/.test(file);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = isGitlab ? /^(\s*)(script|before_script|after_script):\s*(.*)$/.exec(line) : /^(\s*)-?\s*run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const inline = (isGitlab ? m[3] : m[2]).trim();
    if (inline && !/^[|>][-+]?$/.test(inline) && !(isGitlab && inline === "")) {
      if (isGitlab && inline.startsWith("[")) steps.push({ file, run: inline });
      else if (!isGitlab || inline) steps.push({ file, run: inline.replace(/^["']|["']$/g, "") });
      continue;
    }
    // block scalar or gitlab list: gather more-indented following lines
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) {
        block.push("");
        continue;
      }
      const ind = l.length - l.trimStart().length;
      if (ind <= indent) break;
      block.push(l.trim().replace(/^-\s+/, ""));
    }
    const text2 = block.join("\n").trim();
    if (text2) steps.push({ file, run: text2 });
  }
  return steps;
}

async function detectCi(root: string, out: DetectionReport): Promise<void> {
  const wfDir = path.join(root, ".github", "workflows");
  try {
    for (const name of (await readdir(wfDir)).sort()) {
      if (!/\.ya?ml$/.test(name)) continue;
      const t = await readText(path.join(wfDir, name));
      if (t) out.ciSteps.push(...extractCiRunSteps(`.github/workflows/${name}`, t));
    }
  } catch {
    /* no workflows */
  }
  const gl = await readText(path.join(root, ".gitlab-ci.yml"));
  if (gl) out.ciSteps.push(...extractCiRunSteps(".gitlab-ci.yml", gl));
}

export async function detectVerification(repoDir: string, subpath?: string): Promise<DetectionReport> {
  const sub = subpath ? subpath.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "") || null : null;
  const root = sub ? path.join(repoDir, sub) : repoDir;
  const out: DetectionReport = { repoDir, subpath: sub, checks: [], toolchain: [], ciSteps: [], manifests: [], notes: [] };
  await detectNode(root, sub, out);
  await detectRust(root, sub, out);
  await detectGo(root, sub, out);
  await detectPython(root, sub, out);
  await detectMake(root, sub, out);
  await detectPreCommit(root, sub, out);
  await detectToolchainFiles(root, sub, out);
  await detectCi(repoDir, out);
  await fillLocalVersions(out);
  if (!out.manifests.length) out.notes.push("No recognised manifest (package.json, Cargo.toml, go.mod, pyproject.toml, setup.cfg, Makefile). Read CONTRIBUTING and CI for the project's own commands, then pass them explicitly.");
  return out;
}

/** The checks run when the agent asks for "the detected set": non-mutating, non-heavy, no build. */
export function defaultCheckSet(d: DetectionReport, includeKinds?: CheckKind[]): VerificationCheck[] {
  const kinds = new Set<CheckKind>(includeKinds ?? ["format", "lint", "typecheck", "test"]);
  return d.checks.filter((c) => kinds.has(c.kind) && !c.heavy && !c.mayModify);
}
