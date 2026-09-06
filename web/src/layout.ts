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
  api.addPanel({ id: "conversation", component: "conversation", title: "Conversation" });
  api.addPanel({ id: "artifacts", component: "artifacts", title: "Artifacts", position: { referencePanel: "conversation", direction: "within" } });
  api.addPanel({ id: "transcript", component: "transcript", title: "Transcript", position: { referencePanel: "conversation", direction: "within" } });
  api.getPanel("conversation")?.api.setActive();
  api.addPanel({ id: "spine", component: "spine", title: "Progress", position: { referencePanel: "conversation", direction: "left" }, initialWidth: 250 });
  api.addPanel({ id: "files", component: "files", title: "Files", position: { referencePanel: "spine", direction: "within" } });
  api.getPanel("spine")?.api.setActive();
  api.addPanel({ id: "capability", component: "capability", title: "Capability", position: { referencePanel: "spine", direction: "below" } });
  api.addPanel({ id: "session", component: "session", title: "Session", position: { referencePanel: "capability", direction: "within" } });
  api.getPanel("capability")?.api.setActive();
  api.addPanel({ id: "yourturn", component: "yourturn", title: "Your turn", position: { referencePanel: "conversation", direction: "right" }, initialWidth: 340 });
  api.addPanel({ id: "triage", component: "triage", title: "Triage", position: { referencePanel: "yourturn", direction: "within" } });
  api.getPanel("yourturn")?.api.setActive();
  api.addPanel({ id: "verification", component: "verification", title: "Verification", position: { referencePanel: "yourturn", direction: "below" } });
  api.addPanel({ id: "submission", component: "submission", title: "Submission", position: { referencePanel: "verification", direction: "within" } });
  api.addPanel({ id: "feedback", component: "feedback", title: "Feedback log", position: { referencePanel: "verification", direction: "within" } });
  api.getPanel("verification")?.api.setActive();
  api.addPanel({ id: "diff", component: "diff", title: "Diff", position: { referencePanel: "conversation", direction: "below" }, initialHeight: 230 });
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
