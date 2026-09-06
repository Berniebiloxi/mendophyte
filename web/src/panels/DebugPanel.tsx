import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { store } from "../store.js";
import { diag } from "../diag.js";

/**
 * The running debug log: where it is on disk, how big it is, and its
 * tail. Everything the server and this page do lands there, so handing
 * the file over is the whole bug report.
 */
export function DebugPanel() {
  const [info, setInfo] = useState<{ path: string; size: number; enabled: boolean; tail: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const pre = useRef<HTMLPreElement>(null);

  const load = () => api.diag(600).then((r) => { setInfo(r); setErr(null); }).catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    if (!follow) return;
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [follow]);

  useEffect(() => {
    if (follow && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [info?.tail, follow]);

  const copyPath = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.path);
      store.toast("Log path copied");
    } catch {
      store.toast(info.path);
    }
  };

  const lines = (info?.tail ?? "").split("\n").filter((l) => l.startsWith("| "));
  const shown = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;

  return (
    <div className="panel stack dbg">
      <h2>Debug log</h2>
      <p className="muted" style={{ margin: 0 }}>
        One Markdown file per server run. It records every request, socket frame, session event, approval, question, button press, field change and error, with tokens redacted. To report a problem, send this file.
      </p>
      {err && <span className="tag bad">{err}</span>}
      {info && (
        <div className="card">
          <div className="kv">
            <dt>file</dt>
            <dd className="mono" style={{ wordBreak: "break-all" }}>{info.path}</dd>
            <dt>size</dt>
            <dd>{(info.size / 1024).toFixed(1)} KB</dd>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={copyPath}>Copy path</button>
            <a className="btn sm" href="/api/diag/download" download onClick={() => diag("download debug log")}>Download</a>
            <button className="btn sm" onClick={() => { diag("marker: user pressed 'Mark this moment'"); load(); }} title="Writes a marker line so you can say 'the bug happened right after the marker'">Mark this moment</button>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
            <span className="grow" />
            <button className={`btn sm ${info.enabled ? "" : "primary"}`} onClick={() => api.setDiagEnabled(!info.enabled).then(load).catch((e) => store.toast(e.message))} title={info.enabled ? "Stop writing to the log (the file stays; nothing is collected until resumed)" : "Resume writing to the log"}>
              {info.enabled ? "Pause collection" : "Resume collection"}
            </button>
            <span className={`tag ${info.enabled ? "ok" : "warn"}`}>{info.enabled ? "collecting" : "paused"}</span>
          </div>
        </div>
      )}
      <div className="row">
        <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter lines (e.g. error, approval, click)" />
        <span className="faint">{shown.length} of {lines.length}</span>
      </div>
      <pre className="out dbg-tail" ref={pre} style={{ maxHeight: "none", flex: 1, minHeight: 120 }}>
        {shown.map((l) => l.replace(/^\| /, "").replace(/ \|$/, "").replace(/ \| /g, "  ")).join("\n") || "(empty)"}
      </pre>
    </div>
  );
}
