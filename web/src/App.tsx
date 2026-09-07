import { useEffect, useMemo, useRef, useState } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent, DockviewTheme, IDockviewPanelProps } from "dockview";
import { Menubar } from "./Menubar.js";
import { ApprovalsModal } from "./ApprovalsModal.js";
import { applyPreset, buildDefaultLayout, presetForPhase, restoreLayout, saveLayout } from "./layout.js";
import { useActiveSession, useUi } from "./store.js";
import { SessionPanel } from "./panels/SessionPanel.js";
import { SpinePanel } from "./panels/SpinePanel.js";
import { YourTurnPanel } from "./panels/YourTurnPanel.js";
import { ConversationPanel } from "./panels/ConversationPanel.js";
import { CapabilityPanel } from "./panels/CapabilityPanel.js";
import { VerificationPanel } from "./panels/VerificationPanel.js";
import { DiffPanel } from "./panels/DiffPanel.js";
import { TranscriptPanel } from "./panels/TranscriptPanel.js";
import { FileTreePanel } from "./panels/FileTreePanel.js";
import { FileViewerPanel } from "./panels/FileViewerPanel.js";
import { ArtifactsPanel } from "./panels/ArtifactsPanel.js";
import { TerminalPanel } from "./panels/TerminalPanel.js";
import { TriagePanel } from "./panels/TriagePanel.js";
import { SubmissionPanel } from "./panels/SubmissionPanel.js";
import { FeedbackPanel } from "./panels/FeedbackPanel.js";
import { BenchmarkPanel } from "./panels/BenchmarkPanel.js";
import { DebugPanel } from "./panels/DebugPanel.js";

const components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  terminal: TerminalPanel,
  triage: TriagePanel,
  submission: SubmissionPanel,
  feedback: FeedbackPanel,
  benchmark: BenchmarkPanel,
  files: FileTreePanel,
  file: FileViewerPanel,
  artifacts: ArtifactsPanel,
  session: SessionPanel,
  spine: SpinePanel,
  yourturn: YourTurnPanel,
  conversation: ConversationPanel,
  capability: CapabilityPanel,
  verification: VerificationPanel,
  diff: DiffPanel,
  transcript: TranscriptPanel,
  debug: DebugPanel,
};

function useColorScheme(): "light" | "dark" {
  const scheme = useUi((st) => st.scheme);
  const [sys, setSys] = useState<"light" | "dark">(() => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const h = () => setSys(mq.matches ? "dark" : "light");
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return scheme === "auto" ? sys : scheme;
}

export function App() {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const saveTimer = useRef<number | null>(null);
  const colorScheme = useColorScheme();
  const toast = useUi((st) => st.toast);
  const stopped = useUi((st) => st.stopped);
  const nApprovals = useUi((st) => st.approvals.length);
  const nQuestions = useUi((st) => st.questions.length);

  const theme: DockviewTheme = useMemo(
    () => ({ name: "mendophyte", className: "dockview-theme-mendophyte", colorScheme, gap: 8, dndOverlayMounting: "absolute", dndPanelOverlay: "group" }),
    [colorScheme]
  );

  const onReady = (e: DockviewReadyEvent) => {
    if (!restoreLayout(e.api) || e.api.panels.length === 0) buildDefaultLayout(e.api);
    e.api.onDidLayoutChange(() => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => saveLayout(e.api), 400);
    });
    setApi(e.api);
  };

  // Follow the phase: when the agent's phase changes, apply the matching workflow preset.
  const follow = useUi((st) => st.layoutFollowsPhase);
  const active = useActiveSession();
  const phase = active ? (active.livePhase ?? active.lastState?.phase ?? null) : null;
  const lastPreset = useRef<string | null>(null);
  useEffect(() => {
    if (!api || !follow) return;
    const p = presetForPhase(phase);
    if (p && p !== lastPreset.current) {
      lastPreset.current = p;
      applyPreset(api, p);
    }
  }, [api, follow, phase, active?.id]);

  useEffect(() => {
    const base = "Mendophyte";
    const n = nApprovals + nQuestions;
    document.title = n ? `(${n}) your turn · ${base}` : base;
  }, [nApprovals, nQuestions]);

  return (
    <div className="app">
      <Menubar api={api} />
      <div className="app-dock">
        <DockviewReact components={components} onReady={onReady} theme={theme} />
      </div>
      {stopped && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal plain stopped">
            <div className="modal-head"><h2>Mendophyte has stopped</h2></div>
            <div className="modal-body stack">
              <p>The server is shut down and its port is free. Your notes, feedback log, benchmarks and snapshots are on disk in the artifact home.</p>
              <p className="muted">To start again, run <code>npm start</code> in the Mendophyte folder (or <code>mendophyte</code>), then reload this tab. You can close this tab now.</p>
            </div>
          </div>
        </div>
      )}
      <ApprovalsModal />
      {toast && (
        <div style={{ position: "fixed", bottom: 14, left: "50%", transform: "translateX(-50%)", zIndex: 90 }} className="card">
          {toast}
        </div>
      )}
    </div>
  );
}
