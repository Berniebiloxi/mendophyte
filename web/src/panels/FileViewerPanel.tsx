import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { api } from "../api.js";
import { useActiveSession, useUi } from "../store.js";
import type { FileContent } from "../types.js";

/** Read-only view of one repository file, with line numbers. Refreshes after each turn. */
export function FileViewerPanel(props: IDockviewPanelProps<{ path: string }>) {
  const s = useActiveSession();
  const { events } = useUi();
  const p = props.params.path;
  const [file, setFile] = useState<FileContent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const turns = s ? (events[s.id] ?? []).filter((e) => e.event === "turn").length : 0;

  useEffect(() => {
    if (!s) return;
    api.file(s.id, p).then((r) => { setFile(r.file); setErr(null); }).catch((e) => setErr(e.message));
  }, [s?.id, p, turns]);

  if (err) return <div className="panel"><span className="tag bad">{err}</span></div>;
  if (!file) return <div className="panel"><div className="empty">Loading {p}…</div></div>;
  if (file.binary) return <div className="panel"><div className="empty">{p} is binary ({file.bytes} bytes).</div></div>;
  const lines = file.content.split("\n");
  return (
    <div className="fv">
      <div className="row faint" style={{ padding: "4px 10px", borderBottom: "1px solid var(--m-border)", background: "var(--m-bg-2)", fontSize: 11 }}>
        <span className="mono grow">{p}</span>
        <span>{lines.length} lines · {file.bytes} bytes{file.truncated ? " · truncated" : ""}</span>
      </div>
      <div className="fv-body">
        <table>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} id={`L${i + 1}`}>
                <td className="ln">{i + 1}</td>
                <td className="lc">{l || " "}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
