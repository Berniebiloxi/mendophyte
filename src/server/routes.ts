import { Router, type Request, type Response, type NextFunction } from "express";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listArtifactHome } from "../orchestrator/preflight/local.js";
import {
  FeedbackLogError,
  FileAccessError,
  compareRuns,
  detectBenchmarks,
  formatComparison,
  getBenchRun,
  listBenchRuns,
  relabelBenchRun,
  runBenchmark,
  appendFeedbackEntry,
  readFeedbackLog,
  setFeedbackStale,
  computeFragility,
  defaultCheckSet,
  listFiles,
  readTextFile,
  detectVerification,
  formatDetection,
  formatFragilityFacts,
  formatPreflightFacts,
  formatRun,
  formatSubmission,
  readDiff,
  runPreflight,
  runVerification,
  type CheckKind,
  type VerificationCheck,
} from "../orchestrator/index.js";
import { NotFoundError, ValidationError, defaultArtifactHome, type SessionManager } from "./session-manager.js";
import { buildSnapshot, writeSnapshot } from "./snapshot.js";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import { TerminalError, hostInfo, ptyLoadError, type TerminalManager } from "./terminals.js";

/**
 * REST surface for the orchestrator. Commands go here; the event stream
 * is the websocket (ws.ts). Every handler is thin: validate, call the
 * manager, serialise.
 */
export function apiRoutes(manager: SessionManager, terminals: TerminalManager): Router {
  const r = Router();

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };

  // ---- prior projects: one artifact home per repository under ~/.mendophyte
  r.get(
    "/projects",
    wrap(async (_req, res) => {
      const root = path.join(os.homedir(), ".mendophyte");
      const projects: { name: string; artifactHome: string; modified: string }[] = [];
      try {
        for (const name of await readdir(root)) {
          const p = path.join(root, name);
          const st = await stat(p).catch(() => null);
          if (st?.isDirectory()) projects.push({ name, artifactHome: p, modified: st.mtime.toISOString() });
        }
      } catch {
        /* no ~/.mendophyte yet */
      }
      projects.sort((a, b) => b.modified.localeCompare(a.modified));
      res.json({ projects });
    })
  );

  // Managing artifact homes: rename and delete stay inside ~/.mendophyte; move may go anywhere
  // the user names. A home that a live session is using cannot be touched.
  const projectsRoot = () => path.join(os.homedir(), ".mendophyte");
  const safeName = (n: unknown): string => {
    const s = String(n ?? "").trim();
    if (!s || s === "." || s === ".." || /[\\/]/.test(s) || s === "logs") throw new ValidationError("project name must be a single folder name (not 'logs')");
    return s;
  };
  const inUse = (home: string) => manager.list().some((s) => s.artifactHome === home && s.status !== "ended" && s.status !== "error");
  r.post(
    "/projects/:name/rename",
    wrap(async (req, res) => {
      const from = path.join(projectsRoot(), safeName(req.params.name));
      const to = path.join(projectsRoot(), safeName(req.body?.to));
      if (inUse(from)) throw new ValidationError("a running session is using this artifact home; end it first");
      if (await stat(to).catch(() => null)) throw new ValidationError("a project with that name already exists");
      await rename(from, to);
      res.json({ ok: true, artifactHome: to });
    })
  );
  r.post(
    "/projects/:name/move",
    wrap(async (req, res) => {
      const from = path.join(projectsRoot(), safeName(req.params.name));
      const to = path.resolve(String(req.body?.to ?? "").trim());
      if (!to || to === path.resolve(os.homedir()) || to === "/" ) throw new ValidationError("destination must be a folder path that does not exist yet");
      if (inUse(from)) throw new ValidationError("a running session is using this artifact home; end it first");
      if (await stat(to).catch(() => null)) throw new ValidationError("destination already exists");
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      res.json({ ok: true, artifactHome: to });
    })
  );
  r.delete(
    "/projects/:name",
    wrap(async (req, res) => {
      const target = path.join(projectsRoot(), safeName(req.params.name));
      const real = await realpath(target).catch(() => null);
      const rootReal = await realpath(projectsRoot()).catch(() => null);
      if (!real || !rootReal || !real.startsWith(rootReal + path.sep)) throw new NotFoundError("no such project");
      if (inUse(target)) throw new ValidationError("a running session is using this artifact home; end it first");
      await rm(real, { recursive: true, force: true });
      res.json({ ok: true });
    })
  );

  // ---- session snapshot: a Markdown record written to the artifact home, or downloaded
  r.post(
    "/sessions/:id/snapshot",
    wrap(async (req, res) => {
      manager.mustGet(req.params.id);
      res.json(await writeSnapshot(manager, req.params.id));
    })
  );
  r.get("/sessions/:id/snapshot.md", (req, res) => {
    manager.mustGet(req.params.id);
    const { name, markdown } = buildSnapshot(manager, req.params.id);
    res.setHeader("content-type", "text/markdown; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${name}"`);
    res.send(markdown);
  });

  r.get(
    "/sessions/:id/artifacts",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const listing = await listArtifactHome(s.artifactHome);
      res.json({ artifactHome: s.artifactHome, ...listing });
    })
  );

  r.get(
    "/sessions/:id/artifacts/file",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const name = typeof req.query.name === "string" ? req.query.name : "";
      res.json({ file: await readTextFile(s.artifactHome, name) });
    })
  );

  // ---- repository files (file tree + viewer). Read-only, confined to the clone.
  r.get(
    "/sessions/:id/files",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      let fragility = manager.fragilityFor(s.id);
      if (!fragility && req.query.fragility === "1") {
        fragility = await computeFragility({ repoDir: s.repoDir });
        manager.setFragility(s.id, fragility);
      }
      res.json({ listing: await listFiles(s.repoDir, fragility) });
    })
  );

  r.get(
    "/sessions/:id/file",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const p = typeof req.query.path === "string" ? req.query.path : "";
      res.json({ file: await readTextFile(s.repoDir, p) });
    })
  );

  // ---- pre-flight on its own (capability dashboard, "open project" preview)
  r.post(
    "/preflight",
    wrap(async (req, res) => {
      const { repoDir, artifactHome, repoUrl } = req.body ?? {};
      if (typeof repoDir !== "string" || !repoDir) return res.status(400).json({ error: "repoDir is required" });
      const dir = path.resolve(repoDir);
      const report = await runPreflight({ repoDir: dir, artifactHome: path.resolve(artifactHome ?? defaultArtifactHome(dir)), repoUrl });
      res.json({ report, facts: formatPreflightFacts(report) });
    })
  );

  // ---- fragility map (file-tree overlay); the agent gets the same data via its tool
  r.post(
    "/fragility",
    wrap(async (req, res) => {
      const { repoDir, subpath, since, topN } = req.body ?? {};
      if (typeof repoDir !== "string" || !repoDir) return res.status(400).json({ error: "repoDir is required" });
      const report = await computeFragility({ repoDir: path.resolve(repoDir), subpath, since, topN });
      res.json({ report, facts: formatFragilityFacts(report) });
    })
  );

  r.get(
    "/sessions/:id/fragility",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const q = req.query;
      const cached = manager.fragilityFor(s.id);
      const wantsCached = q.subpath === undefined && q.since === undefined && q.refresh === undefined;
      if (wantsCached && cached) return res.json({ report: cached, facts: formatFragilityFacts(cached), cached: true });
      const report = await computeFragility({
        repoDir: s.repoDir,
        subpath: typeof q.subpath === "string" ? q.subpath : undefined,
        since: typeof q.since === "string" ? q.since : undefined,
      });
      if (wantsCached) manager.setFragility(s.id, report);
      res.json({ report, facts: formatFragilityFacts(report), cached: false });
    })
  );

  // ---- verification (diff / verification panel). The agent's tool calls land in the same history.
  const parseChecks = (raw: unknown): VerificationCheck[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c) => c && typeof c.command === "string" && c.command.trim())
      .map((c) => ({
        id: typeof c.id === "string" ? c.id : c.command,
        kind: (typeof c.kind === "string" ? c.kind : "other") as CheckKind,
        command: c.command,
        cwd: typeof c.cwd === "string" ? c.cwd : undefined,
        source: "passed explicitly via the API",
        successRule: c.successRule === "no-output" ? "no-output" : "exit-zero",
      }));
  };

  r.post(
    "/verification/detect",
    wrap(async (req, res) => {
      const { repoDir, subpath } = req.body ?? {};
      if (typeof repoDir !== "string" || !repoDir) return res.status(400).json({ error: "repoDir is required" });
      const detected = await detectVerification(path.resolve(repoDir), subpath);
      res.json({ detected, facts: formatDetection(detected), defaultSet: defaultCheckSet(detected) });
    })
  );

  r.get(
    "/sessions/:id/verification",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      res.json(manager.verificationFor(s.id));
    })
  );

  r.post(
    "/sessions/:id/verification/detect",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const detected = await detectVerification(s.repoDir, req.body?.subpath);
      manager.recordVerificationDetected(s.id, detected);
      res.json({ detected, facts: formatDetection(detected), defaultSet: defaultCheckSet(detected) });
    })
  );

  r.post(
    "/sessions/:id/verification",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const b = req.body ?? {};
      const checks: VerificationCheck[] = [];
      if (b.useDetected) {
        const d = await detectVerification(s.repoDir, b.subpath);
        manager.recordVerificationDetected(s.id, d);
        checks.push(...defaultCheckSet(d, Array.isArray(b.includeKinds) ? b.includeKinds : undefined));
      }
      checks.push(...parseChecks(b.checks));
      if (!checks.length) return res.status(400).json({ error: "nothing to run: pass useDetected or checks[]" });
      const run = await runVerification({
        repoDir: s.repoDir,
        artifactHome: s.artifactHome,
        checks,
        timeoutMs: typeof b.timeoutMinutes === "number" ? b.timeoutMinutes * 60_000 : undefined,
        failFast: Boolean(b.failFast),
        onProgress: (p) => manager.recordVerificationProgress(s.id, p),
      });
      manager.recordVerification(s.id, run);
      res.json({ run, facts: formatRun(run) });
    })
  );

  r.get(
    "/sessions/:id/diff",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      res.json({ diff: await readDiff(s.repoDir, { includeUntracked: req.query.untracked !== "0" }) });
    })
  );

  r.post(
    "/diff",
    wrap(async (req, res) => {
      const { repoDir } = req.body ?? {};
      if (typeof repoDir !== "string" || !repoDir) return res.status(400).json({ error: "repoDir is required" });
      res.json({ diff: await readDiff(path.resolve(repoDir)) });
    })
  );

  // ---- sessions
  r.get("/sessions", (_req, res) => res.json({ sessions: manager.list() }));

  r.post(
    "/sessions",
    wrap(async (req, res) => {
      const b = req.body ?? {};
      if (typeof b.repoDir !== "string" || !b.repoDir) return res.status(400).json({ error: "repoDir is required" });
      const summary = await manager.create({
        repoDir: b.repoDir,
        artifactHome: b.artifactHome,
        repoUrl: b.repoUrl,
        model: b.model,
        maxTurns: b.maxTurns,
        preflight: b.preflight,
        kickoff: b.kickoff,
        noKickoff: b.noKickoff,
        promptDir: b.promptDir,
        allowNonGit: b.allowNonGit,
      });
      res.status(201).json({ session: summary });
    })
  );

  r.get("/sessions/:id", (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    res.json({ session: s, approvals: manager.pendingApprovals().filter((a) => a.sessionId === s.id) });
  });

  r.get("/sessions/:id/events", (req, res) => {
    if (!manager.get(req.params.id)) return res.status(404).json({ error: "not found" });
    const after = Number(req.query.after ?? 0);
    res.json({ events: manager.events(req.params.id, Number.isFinite(after) ? after : 0) });
  });

  r.get("/sessions/:id/preflight", (req, res) => {
    if (!manager.get(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json(manager.preflightFor(req.params.id));
  });

  r.post("/sessions/:id/messages", (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text is required" });
    manager.send(req.params.id, text);
    res.status(202).json({ ok: true });
  });

  r.post(
    "/sessions/:id/interrupt",
    wrap(async (req, res) => {
      await manager.interrupt(req.params.id);
      res.status(202).json({ ok: true });
    })
  );

  r.post("/sessions/:id/end", (req, res) => {
    manager.end(req.params.id);
    res.status(202).json({ ok: true });
  });

  r.delete("/sessions/:id", (req, res) => {
    if (!manager.remove(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  // ---- benchmarks (performance sessions): detect, run, persist, compare
  r.get(
    "/sessions/:id/benchmarks",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const [detection, runs] = await Promise.all([detectBenchmarks(s.repoDir), listBenchRuns(s.artifactHome)]);
      res.json({ detection, runs });
    })
  );

  r.post(
    "/sessions/:id/benchmarks/run",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const b = req.body ?? {};
      if (typeof b.command !== "string" || !b.command.trim()) return res.status(400).json({ error: "command is required" });
      const run = await runBenchmark({ repoDir: s.repoDir, artifactHome: s.artifactHome, command: b.command, label: typeof b.label === "string" ? b.label : undefined, tool: b.tool, cwd: typeof b.cwd === "string" ? b.cwd : undefined, timeoutMs: typeof b.timeoutMinutes === "number" ? b.timeoutMinutes * 60_000 : undefined });
      manager.recordBenchmark(s.id, run);
      res.status(201).json({ run });
    })
  );

  r.post(
    "/sessions/:id/benchmarks/:runId/label",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      if (typeof req.body?.label !== "string") return res.status(400).json({ error: "label is required" });
      const run = await relabelBenchRun(s.artifactHome, req.params.runId, req.body.label);
      if (!run) return res.status(404).json({ error: "no such run" });
      manager.recordBenchmark(s.id, run);
      res.json({ run });
    })
  );

  r.get(
    "/sessions/:id/benchmarks/compare",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const b = typeof req.query.baseline === "string" ? await getBenchRun(s.artifactHome, req.query.baseline) : null;
      const a = typeof req.query.after === "string" ? await getBenchRun(s.artifactHome, req.query.after) : null;
      if (!b || !a) return res.status(400).json({ error: "baseline and after must be saved run ids" });
      const comparison = compareRuns(b, a);
      res.json({ comparison, facts: formatComparison(comparison) });
    })
  );

  // ---- Artifact F: the per-project feedback log (append-only, taggable)
  r.get(
    "/sessions/:id/feedback",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      res.json({ log: await readFeedbackLog(s.artifactHome) });
    })
  );

  r.post(
    "/sessions/:id/feedback",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const b = req.body ?? {};
      if (typeof b.lesson !== "string" || !b.lesson.trim()) return res.status(400).json({ error: "lesson is required" });
      const { entry, log } = await appendFeedbackEntry(s.artifactHome, { lesson: b.lesson, tags: b.tags, source: typeof b.source === "string" ? b.source : null });
      manager.recordFeedbackLog(s.id, log);
      res.status(201).json({ entry, log });
    })
  );

  r.post(
    "/sessions/:id/feedback/:entryId/stale",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      if (typeof req.body?.stale !== "boolean") return res.status(400).json({ error: "stale (boolean) is required" });
      const log = await setFeedbackStale(s.artifactHome, req.params.entryId, req.body.stale);
      manager.recordFeedbackLog(s.id, log);
      res.json({ log });
    })
  );

  // ---- submission (Phase 5): PR, CI, template compliance, sign-off, sync
  r.get(
    "/sessions/:id/submission",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const cur = manager.submissionFor(s.id);
      if (cur.report && req.query.refresh !== "1") return res.json({ ...cur, facts: formatSubmission(cur.report) });
      const report = await manager.refreshSubmission(s.id);
      res.json({ report, pollingSec: manager.submissionFor(s.id).pollingSec, facts: formatSubmission(report) });
    })
  );

  r.post(
    "/sessions/:id/submission/refresh",
    wrap(async (req, res) => {
      const s = manager.get(req.params.id);
      if (!s) return res.status(404).json({ error: "not found" });
      const report = await manager.refreshSubmission(s.id, { fetch: Boolean(req.body?.fetch) });
      res.json({ report, pollingSec: manager.submissionFor(s.id).pollingSec, facts: formatSubmission(report) });
    })
  );

  r.post("/sessions/:id/submission/poll", (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    const v = req.body?.intervalSec;
    if (v !== null && typeof v !== "number") return res.status(400).json({ error: "intervalSec must be a number of seconds or null to stop" });
    manager.setSubmissionPolling(s.id, v);
    res.json({ pollingSec: manager.submissionFor(s.id).pollingSec });
  });

  // ---- terminals: the user's own shells in the clone (not gated, not the agent's)
  r.get("/terminals/host", (_req, res) => res.json({ ...hostInfo, ptyError: ptyLoadError() }));

  r.get("/sessions/:id/terminals", (req, res) => {
    if (!manager.get(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json({ terminals: terminals.list(req.params.id) });
  });

  r.post("/sessions/:id/terminals", (req, res) => {
    const s = manager.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    const b = req.body ?? {};
    const t = terminals.create({ sessionId: s.id, cwd: s.repoDir, cols: typeof b.cols === "number" ? b.cols : undefined, rows: typeof b.rows === "number" ? b.rows : undefined });
    res.status(201).json({ terminal: t });
  });

  r.delete("/sessions/:id/terminals/:tid", (req, res) => {
    const t = terminals.get(req.params.tid);
    if (!t || t.sessionId !== req.params.id) return res.status(404).json({ error: "not found" });
    terminals.kill(t.id);
    res.json({ ok: true });
  });

  // ---- approvals
  r.get("/approvals", (_req, res) => res.json({ approvals: manager.pendingApprovals() }));

  // ---- AskUserQuestion answers
  r.get("/questions", (_req, res) => res.json({ questions: manager.pendingQuestions() }));
  r.post("/questions/:id", (req, res) => {
    const b = req.body ?? {};
    if (b.dismiss === true) {
      if (!manager.dismissQuestion(req.params.id, typeof b.reason === "string" ? b.reason : undefined)) return res.status(404).json({ error: "no such pending question" });
      return res.json({ ok: true });
    }
    if (!b.answers || typeof b.answers !== "object") return res.status(400).json({ error: "answers (object keyed by question text) is required" });
    if (!manager.answerQuestion(req.params.id, b.answers)) return res.status(404).json({ error: "no such pending question" });
    res.json({ ok: true });
  });

  r.post("/approvals/:id", (req, res) => {
    const b = req.body ?? {};
    if (typeof b.approved !== "boolean") return res.status(400).json({ error: "approved (boolean) is required" });
    const ok = manager.resolveApproval(
      req.params.id,
      b.approved ? { approved: true, decidedBy: "http" } : { approved: false, reason: typeof b.reason === "string" ? b.reason : undefined, decidedBy: "http" }
    );
    if (!ok) return res.status(404).json({ error: "no such pending approval" });
    res.json({ ok: true });
  });

  // ---- errors
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof FileAccessError) return res.status(err.message === "not found" ? 404 : 400).json({ error: err.message });
    if (err instanceof TerminalError) return res.status(err.message.startsWith("at most") ? 429 : 503).json({ error: err.message });
    if (err instanceof FeedbackLogError) return res.status(err.message.startsWith("no entry") ? 404 : 400).json({ error: err.message });
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  });

  return r;
}
