import type { DockviewApi } from "dockview";

/** Panel registry: id, component key and title, in the order the View menu lists them. */
export const PANELS = [
  { id: "spine", title: "Progress" },
  { id: "files", title: "Files" },
  { id: "session", title: "Session" },
  { id: "capability", title: "Capability" },
  { id: "conversation", title: "Conversation" },
  { id: "artifacts", title: "Artifacts" },
  { id: "transcript", title: "Transcript" },
  { id: "yourturn", title: "Your turn" },
  { id: "triage", title: "Triage" },
  { id: "verification", title: "Verification" },
  { id: "submission", title: "Submission" },
  { id: "feedback", title: "Feedback log" },
  { id: "benchmark", title: "Benchmark" },
  { id: "diff", title: "Diff" },
  { id: "debug", title: "Debug log" },
] as const;
export type PanelId = (typeof PANELS)[number]["id"];

/** Terminals are multi-instance: each gets its own id, docked next to the diff. */
export function newTerminal(api: DockviewApi): void {
  const id = `terminal:${Date.now().toString(36)}`;
  const ref = api.getPanel("diff") ? "diff" : api.getPanel("conversation") ? "conversation" : api.panels[0]?.id;
  api.addPanel({ id, component: "terminal", title: "Terminal", params: {}, position: ref ? { referencePanel: ref, direction: ref === "diff" ? "within" : "below" } : undefined });
}

const LS_LAYOUT = "mendophyte.layout";
const LS_NAMED = "mendophyte.layouts";

export function buildDefaultLayout(api: DockviewApi): void {
  api.clear();
  const w = window.innerWidth || 1440;
  const h = window.innerHeight || 900;
  const left = Math.round(Math.max(220, Math.min(420, w * 0.17)));
  const right = Math.round(Math.max(300, Math.min(560, w * 0.24)));
  const bottom = Math.round(Math.max(160, Math.min(360, h * 0.26)));
  api.addPanel({ id: "conversation", component: "conversation", title: "Conversation" });
  api.addPanel({ id: "artifacts", component: "artifacts", title: "Artifacts", position: { referencePanel: "conversation", direction: "within" } });
  api.addPanel({ id: "transcript", component: "transcript", title: "Transcript", position: { referencePanel: "conversation", direction: "within" } });
  api.getPanel("conversation")?.api.setActive();
  api.addPanel({ id: "spine", component: "spine", title: "Progress", position: { referencePanel: "conversation", direction: "left" }, initialWidth: left });
  api.addPanel({ id: "files", component: "files", title: "Files", position: { referencePanel: "spine", direction: "within" } });
  api.getPanel("spine")?.api.setActive();
  api.addPanel({ id: "capability", component: "capability", title: "Capability", position: { referencePanel: "spine", direction: "below" } });
  api.addPanel({ id: "session", component: "session", title: "Session", position: { referencePanel: "capability", direction: "within" } });
  api.getPanel("capability")?.api.setActive();
  api.addPanel({ id: "yourturn", component: "yourturn", title: "Your turn", position: { referencePanel: "conversation", direction: "right" }, initialWidth: right });
  api.addPanel({ id: "triage", component: "triage", title: "Triage", position: { referencePanel: "yourturn", direction: "within" } });
  api.getPanel("yourturn")?.api.setActive();
  api.addPanel({ id: "verification", component: "verification", title: "Verification", position: { referencePanel: "yourturn", direction: "below" } });
  api.addPanel({ id: "submission", component: "submission", title: "Submission", position: { referencePanel: "verification", direction: "within" } });
  api.addPanel({ id: "feedback", component: "feedback", title: "Feedback log", position: { referencePanel: "verification", direction: "within" } });
  api.getPanel("verification")?.api.setActive();
  api.addPanel({ id: "diff", component: "diff", title: "Diff", position: { referencePanel: "conversation", direction: "below" }, initialHeight: bottom });
  api.addPanel({ id: "terminal:default", component: "terminal", title: "Terminal", params: {}, position: { referencePanel: "diff", direction: "within" } });
  api.getPanel("diff")?.api.setActive();
}

export function saveLayout(api: DockviewApi): void {
  try {
    localStorage.setItem(LS_LAYOUT, JSON.stringify(api.toJSON()));
  } catch {
    /* ignore */
  }
}

export function restoreLayout(api: DockviewApi): boolean {
  try {
    const raw = localStorage.getItem(LS_LAYOUT);
    if (!raw) return false;
    api.fromJSON(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}

export function namedLayouts(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(LS_NAMED) ?? "{}");
  } catch {
    return {};
  }
}
export function saveNamedLayout(api: DockviewApi, name: string): void {
  const all = namedLayouts();
  all[name] = api.toJSON();
  localStorage.setItem(LS_NAMED, JSON.stringify(all));
}
export function loadNamedLayout(api: DockviewApi, name: string): boolean {
  const l = namedLayouts()[name];
  if (!l) return false;
  api.fromJSON(l as any);
  return true;
}
export function deleteNamedLayout(name: string): void {
  const all = namedLayouts();
  delete all[name];
  localStorage.setItem(LS_NAMED, JSON.stringify(all));
}

/** Opens a closed panel next to the conversation, or focuses it if open. */
export function showPanel(api: DockviewApi, id: PanelId): void {
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const def = PANELS.find((p) => p.id === id)!;
  const ref = api.getPanel("conversation") ? "conversation" : api.panels[0]?.id;
  api.addPanel({ id, component: id, title: def.title, position: ref ? { referencePanel: ref, direction: id === "diff" ? "below" : "right" } : undefined });
}

// ---- workflow presets ---------------------------------------------------
//
// Each preset arranges the panels around one part of the process. "Follow
// the phase" (a setting in the store) applies the matching preset as the
// agent moves: 0-2 orient, 3 triage, 4 fix, 5 submit.

export type PresetId = "overview" | "orient" | "triage" | "fix" | "submit" | "focus";
export const PRESETS: { id: PresetId; title: string; hint: string; phases: number[] }[] = [
  { id: "overview", title: "Overview", hint: "everything, the default", phases: [] },
  { id: "orient", title: "Orientation", hint: "files, artifacts, capability", phases: [0, 1, 2] },
  { id: "triage", title: "Triage", hint: "the board next to the conversation", phases: [3] },
  { id: "fix", title: "Fix", hint: "diff, terminal, verification", phases: [4] },
  { id: "submit", title: "Submission", hint: "PR status, feedback log, diff", phases: [5] },
  { id: "focus", title: "Focus", hint: "conversation and your turn only", phases: [] },
];

export function presetForPhase(phase: number | null): PresetId | null {
  if (phase === null) return null;
  return PRESETS.find((p) => p.phases.includes(phase))?.id ?? null;
}

function add(api: DockviewApi, id: string, opts: { ref?: string; dir?: "left" | "right" | "above" | "below" | "within"; width?: number; height?: number; title?: string; component?: string } = {}) {
  const def = PANELS.find((p) => p.id === id);
  api.addPanel({
    id,
    component: opts.component ?? id,
    title: opts.title ?? def?.title ?? id,
    params: id.startsWith("terminal") ? {} : undefined,
    position: opts.ref ? { referencePanel: opts.ref, direction: opts.dir ?? "within" } : undefined,
    initialWidth: opts.width,
    initialHeight: opts.height,
  });
}

export function applyPreset(api: DockviewApi, preset: PresetId): void {
  if (preset === "overview") return buildDefaultLayout(api);
  const w = window.innerWidth || 1440;
  const h = window.innerHeight || 900;
  const side = Math.round(Math.max(240, Math.min(460, w * 0.2)));
  const wide = Math.round(Math.max(320, Math.min(640, w * 0.3)));
  const row = Math.round(Math.max(180, Math.min(420, h * 0.34)));
  api.clear();
  switch (preset) {
    case "orient":
      add(api, "conversation");
      add(api, "files", { ref: "conversation", dir: "left", width: side });
      add(api, "spine", { ref: "files", dir: "within" });
      api.getPanel("files")?.api.setActive();
      add(api, "capability", { ref: "files", dir: "below" });
      add(api, "artifacts", { ref: "conversation", dir: "right", width: wide });
      add(api, "yourturn", { ref: "artifacts", dir: "below", height: row });
      break;
    case "triage":
      add(api, "conversation");
      add(api, "spine", { ref: "conversation", dir: "left", width: side });
      add(api, "triage", { ref: "conversation", dir: "right", width: wide });
      add(api, "yourturn", { ref: "triage", dir: "below", height: row });
      add(api, "artifacts", { ref: "conversation", dir: "within" });
      api.getPanel("conversation")?.api.setActive();
      break;
    case "fix":
      add(api, "conversation");
      add(api, "files", { ref: "conversation", dir: "left", width: side });
      add(api, "spine", { ref: "files", dir: "within" });
      api.getPanel("files")?.api.setActive();
      add(api, "diff", { ref: "conversation", dir: "right", width: wide });
      add(api, "terminal:default", { ref: "diff", dir: "below", height: row, component: "terminal", title: "Terminal" });
      add(api, "yourturn", { ref: "conversation", dir: "below", height: row });
      add(api, "verification", { ref: "yourturn", dir: "within" });
      api.getPanel("yourturn")?.api.setActive();
      break;
    case "submit":
      add(api, "conversation");
      add(api, "spine", { ref: "conversation", dir: "left", width: side });
      add(api, "submission", { ref: "conversation", dir: "right", width: wide });
      add(api, "feedback", { ref: "submission", dir: "within" });
      api.getPanel("submission")?.api.setActive();
      add(api, "yourturn", { ref: "submission", dir: "below", height: row });
      add(api, "diff", { ref: "conversation", dir: "below", height: row });
      add(api, "artifacts", { ref: "diff", dir: "within" });
      api.getPanel("diff")?.api.setActive();
      break;
    case "focus":
      add(api, "conversation");
      add(api, "yourturn", { ref: "conversation", dir: "right", width: wide });
      break;
  }
}

export function renameNamedLayout(from: string, to: string): boolean {
  const all = namedLayouts();
  if (!(from in all) || to in all || !to.trim()) return false;
  all[to] = all[from];
  delete all[from];
  localStorage.setItem(LS_NAMED, JSON.stringify(all));
  return true;
}
