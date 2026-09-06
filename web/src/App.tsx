import { useEffect, useMemo, useRef, useState } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent, DockviewTheme, IDockviewPanelProps } from "dockview";
import { Menubar } from "./Menubar.js";
import { ApprovalsModal } from "./ApprovalsModal.js";
import { buildDefaultLayout, restoreLayout, saveLayout } from "./layout.js";
import { useUi } from "./store.js";
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
};

function useColorScheme(): "light" | "dark" {
  const { scheme } = useUi();
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
  const { toast, approvals, questions } = useUi();

  const theme: DockviewTheme = useMemo(
    () => ({ name: "mendophyte", className: "dockview-theme-mendophyte", colorScheme, gap: 4, dndOverlayMounting: "absolute", dndPanelOverlay: "group" }),
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

  useEffect(() => {
    const base = "Mendophyte";
    const n = approvals.length + questions.length;
    document.title = n ? `(${n}) your turn · ${base}` : base;
  }, [approvals.length, questions.length]);

  return (
    <div className="app">
      <Menubar api={api} />
      <div className="app-dock">
        <DockviewReact components={components} onReady={onReady} theme={theme} />
      </div>
      <ApprovalsModal />
      {toast && (
        <div style={{ position: "fixed", bottom: 14, left: "50%", transform: "translateX(-50%)", zIndex: 90 }} className="card">
          {toast}
        </div>
      )}
    </div>
  );
}
