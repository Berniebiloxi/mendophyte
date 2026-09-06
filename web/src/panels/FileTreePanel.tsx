import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { api } from "../api.js";
import { store, useActiveSession } from "../store.js";
import type { FileEntry, FileListing } from "../types.js";

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
  entry?: FileEntry;
  /** Aggregated for directories: max heat below, summed counts. */
  heat: number;
  commits: number;
  fixCommits: number;
  markers: number;
}

function buildTree(files: FileEntry[]): Node {
  const root: Node = { name: "", path: "", dir: true, children: [], heat: 0, commits: 0, fixCommits: 0, markers: 0 };
  const dirs = new Map<string, Node>([["", root]]);
  const dirFor = (p: string): Node => {
    let n = dirs.get(p);
    if (n) return n;
    const i = p.lastIndexOf("/");
    const parent = dirFor(i === -1 ? "" : p.slice(0, i));
    n = { name: i === -1 ? p : p.slice(i + 1), path: p, dir: true, children: [], heat: 0, commits: 0, fixCommits: 0, markers: 0 };
    parent.children.push(n);
    dirs.set(p, n);
    return n;
  };
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const parent = dirFor(i === -1 ? "" : f.path.slice(0, i));
    parent.children.push({ name: i === -1 ? f.path : f.path.slice(i + 1), path: f.path, dir: false, children: [], entry: f, heat: f.heat ?? 0, commits: f.commits ?? 0, fixCommits: f.fixCommits ?? 0, markers: f.markers ?? 0 });
  }
  const finish = (n: Node) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    for (const c of n.children) {
      if (c.dir) finish(c);
      n.heat = Math.max(n.heat, c.heat);
      n.commits += c.commits;
      n.fixCommits += c.fixCommits;
      n.markers += c.markers;
    }
  };
  finish(root);
  return root;
}

function heatColor(h: number): string {
  if (h <= 0) return "transparent";
  // vine green -> bloom gold -> danger red as heat rises
  if (h < 0.35) return "var(--m-accent-2)";
  if (h < 0.7) return "var(--m-bloom)";
  return "var(--m-danger)";
}

function Row({ n, depth, open, toggle, onOpen, overlay, filter }: { n: Node; depth: number; open: Set<string>; toggle: (p: string) => void; onOpen: (p: string) => void; overlay: boolean; filter: string }) {
  const isOpen = open.has(n.path) || Boolean(filter);
  const title = overlay ? `${n.commits} commits · ${n.fixCommits} fix commits · ${n.markers} TODO-class markers${n.entry?.lastTouched ? ` · last touched ${n.entry.lastTouched}` : ""}` : n.path;
  return (
    <>
      <div className={`ft-row${n.dir ? " dir" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} title={title} onClick={() => (n.dir ? toggle(n.path) : onOpen(n.path))}>
        <span className="ft-tw">{n.dir ? (isOpen ? "▾" : "▸") : ""}</span>
        <span className="ft-name">{n.name}</span>
        {overlay && n.heat > 0 && <span className="ft-heat" style={{ background: heatColor(n.heat), width: 6 + Math.round(n.heat * 34) }} />}
        {overlay && n.fixCommits > 0 && <span className="ft-n" title="fix commits">{n.fixCommits}f</span>}
        {overlay && n.markers > 0 && <span className="ft-n" title="TODO/FIXME/HACK/XXX">{n.markers}t</span>}
      </div>
      {n.dir && isOpen && n.children.map((c) => <Row key={c.path} n={c} depth={depth + 1} open={open} toggle={toggle} onOpen={onOpen} overlay={overlay} filter={filter} />)}
    </>
  );
}

function filterTree(n: Node, q: string): Node | null {
  if (!q) return n;
  if (!n.dir) return n.path.toLowerCase().includes(q) ? n : null;
  const kids = n.children.map((c) => filterTree(c, q)).filter((x): x is Node => Boolean(x));
  return kids.length ? { ...n, children: kids } : null;
}

export function FileTreePanel(props: IDockviewPanelProps) {
  const s = useActiveSession();
  const [listing, setListing] = useState<FileListing | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [filter, setFilter] = useState("");

  const load = async (withFragility: boolean) => {
    if (!s) return;
    setBusy(true);
    try {
      const r = await api.files(s.id, withFragility);
      setListing(r.listing);
      if (r.listing.fragilityWindow) setOverlay(true);
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setListing(null);
    setOpen(new Set([""]));
    if (s) void load(false);
  }, [s?.id]);

  const tree = useMemo(() => (listing ? buildTree(listing.files) : null), [listing]);
  const shown = useMemo(() => (tree ? filterTree(tree, filter.trim().toLowerCase()) : null), [tree, filter]);

  const openFile = (p: string) => {
    const id = `file:${p}`;
    const existing = props.containerApi.getPanel(id);
    if (existing) return existing.api.setActive();
    props.containerApi.addPanel({ id, component: "file", title: p.split("/").pop() ?? p, params: { path: p }, position: { referencePanel: props.containerApi.getPanel("conversation") ? "conversation" : props.api.id, direction: "within" } });
  };

  if (!s) return <div className="panel"><div className="empty">No session.</div></div>;
  const hasOverlay = Boolean(listing?.fragilityWindow);
  return (
    <div className="ft">
      <div className="row" style={{ padding: "6px 8px", borderBottom: "1px solid var(--m-border)", background: "var(--m-bg-2)" }}>
        <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter paths" style={{ flex: 1, minWidth: 80 }} />
        <button className="btn sm" disabled={busy} onClick={() => load(true)} title="Compute churn / fix-cluster / marker heat from git history and overlay it">
          {busy ? "…" : hasOverlay ? "Recompute heat" : "Show fragility"}
        </button>
        {hasOverlay && (
          <label className="row" style={{ fontSize: 11 }}>
            <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> overlay
          </label>
        )}
      </div>
      {listing?.fragilityWindow && overlay && (
        <div className="faint" style={{ padding: "4px 8px", fontSize: 11, borderBottom: "1px solid var(--m-border)" }}>
          heat = churn, fix commits, TODO-class markers over {listing.fragilityWindow.commitsScanned} commits since {listing.fragilityWindow.oldest ?? "—"}. Hover a row for the numbers; the bar is a hint, the numbers are the evidence.
        </div>
      )}
      <div className="ft-body">
        {!listing && <div className="empty" style={{ padding: 10 }}>Loading…</div>}
        {listing?.error && <div className="tag bad" style={{ margin: 10, whiteSpace: "normal" }}>{listing.error}</div>}
        {shown && shown.children.map((c) => (
          <Row key={c.path} n={c} depth={0} open={open} toggle={(p) => setOpen((o) => { const n = new Set(o); n.has(p) ? n.delete(p) : n.add(p); return n; })} onOpen={openFile} overlay={overlay && hasOverlay} filter={filter.trim().toLowerCase()} />
        ))}
        {listing && !listing.error && shown && shown.children.length === 0 && <div className="empty" style={{ padding: 10 }}>No matches.</div>}
        {listing?.truncated && <div className="faint" style={{ padding: 8 }}>Listing truncated at 20,000 files.</div>}
      </div>
    </div>
  );
}
