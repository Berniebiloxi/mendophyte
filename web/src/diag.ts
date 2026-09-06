/**
 * Browser half of the debug log. Records what the person did (every
 * button press, every field change, every menu pick), what the store did
 * (sends, answers, approvals, theme), what the socket did, and every JS
 * error, then ships them to the server in small batches where they land
 * in the same Markdown file as the server's own lines.
 *
 * Text values are kept short. Fields that look like secrets are never
 * recorded; the server redacts anything that slips through.
 */

type Source = "ui" | "error";
interface Entry {
  at: string;
  source: Source;
  text: string;
}

const queue: Entry[] = [];
let timer: number | null = null;
let failures = 0;

function push(source: Source, text: string) {
  queue.push({ at: new Date().toISOString(), source, text: text.length > 500 ? `${text.slice(0, 500)}…` : text });
  if (queue.length > 500) queue.splice(0, queue.length - 500);
  if (timer == null) timer = window.setTimeout(flush, 800);
}

async function flush(useBeacon = false) {
  timer = null;
  if (!queue.length) return;
  const entries = queue.splice(0, queue.length);
  const body = JSON.stringify({ entries });
  try {
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon("/api/diag", new Blob([body], { type: "application/json" }));
      return;
    }
    const res = await fetch("/api/diag", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true });
    failures = res.ok ? 0 : failures + 1;
  } catch {
    failures += 1;
    // Keep the last batch for one retry, then drop rather than grow forever.
    if (failures <= 3) queue.unshift(...entries.slice(-100));
    if (timer == null) timer = window.setTimeout(flush, 3000);
  }
}

/** Something the UI did on purpose: a store action, a navigation, a toast. */
export function diag(text: string) {
  push("ui", text);
}

export function diagError(text: string) {
  push("error", text);
}

/** Where a click happened: the dockview panel's active tab title, or the menubar/modal. */
function whereIs(el: Element): string {
  if (el.closest(".menubar")) return "menubar";
  if (el.closest(".modal")) return "modal";
  const group = el.closest(".dv-groupview");
  const tab = group?.querySelector(".dv-tab.dv-active-tab, .dv-tab.active-tab, .dv-tab[aria-selected='true']");
  const title = tab?.textContent?.trim();
  return title ? title.replace(/\s+/g, " ").slice(0, 40) : el.closest(".panel, .conv, .art, .term, .ft, .fv, .diff-wrap, .spine")?.className.split(" ")[0] ?? "page";
}

function describe(el: HTMLElement): string {
  const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
  return label ? `"${label.slice(0, 60)}"` : `<${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}>`;
}

const SECRET_FIELD = /pass|token|secret|key/i;

function fieldName(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  return el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("placeholder") || el.closest("label")?.textContent?.trim().slice(0, 40) || el.tagName.toLowerCase();
}

let installed = false;

/** Global listeners; call once at boot. */
export function installDiagListeners() {
  if (installed) return;
  installed = true;

  document.addEventListener(
    "click",
    (ev) => {
      const t = ev.target as Element | null;
      const el = t?.closest("button, a, summary, [role=button], .dv-tab, .ft-row, .art-item, .tri-card, .gauge-seg") as HTMLElement | null;
      if (!el) return;
      const kind = el.classList.contains("dv-tab") ? "tab" : el.tagName === "A" ? "link" : el.tagName === "SUMMARY" ? "toggle" : el.tagName === "BUTTON" ? "button" : "item";
      push("ui", `click ${kind} ${describe(el)} in ${whereIs(el)}${(el as HTMLButtonElement).disabled ? " (disabled)" : ""}`);
    },
    true
  );

  document.addEventListener(
    "change",
    (ev) => {
      const el = ev.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (!el || !("value" in el)) return;
      const name = fieldName(el);
      const type = (el as HTMLInputElement).type;
      let val: string;
      if (type === "checkbox" || type === "radio") val = (el as HTMLInputElement).checked ? "on" : "off";
      else if (type === "password" || SECRET_FIELD.test(name)) val = `(${el.value.length} chars, hidden)`;
      else if (el.value.length > 120) val = `"${el.value.slice(0, 120).replace(/\s+/g, " ")}…" (${el.value.length} chars)`;
      else val = `"${el.value.replace(/\s+/g, " ")}"`;
      push("ui", `change ${el.tagName.toLowerCase()}${type ? `[${type}]` : ""} ${name.slice(0, 40)} = ${val} in ${whereIs(el)}`);
    },
    true
  );

  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Enter" || !(ev.target instanceof HTMLTextAreaElement)) return;
      if (ev.shiftKey) return;
      push("ui", `Enter${ev.metaKey || ev.ctrlKey ? " (with ctrl/cmd)" : ""} in textarea ${fieldName(ev.target).slice(0, 40)} in ${whereIs(ev.target)}`);
    },
    true
  );

  window.addEventListener("error", (ev) => {
    push("error", `window.error ${ev.message} @ ${ev.filename?.split("/").pop() ?? "?"}:${ev.lineno}:${ev.colno}${ev.error?.stack ? ` ${String(ev.error.stack).split("\n").slice(0, 4).join(" | ")}` : ""}`);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r: any = ev.reason;
    push("error", `unhandledrejection ${r instanceof Error ? `${r.message} ${String(r.stack ?? "").split("\n").slice(0, 4).join(" | ")}` : String(r).slice(0, 300)}`);
  });

  // Long tasks are the objective measure of "sluggish". Chrome-only; harmless elsewhere.
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 100) push("ui", `slow: main thread blocked ${Math.round(e.duration)}ms`);
    });
    po.observe({ type: "longtask", buffered: false });
  } catch {
    /* unsupported */
  }

  document.addEventListener("visibilitychange", () => {
    push("ui", `tab ${document.visibilityState}`);
    if (document.visibilityState === "hidden") void flush(true);
  });
  window.addEventListener("pagehide", () => void flush(true));

  push("ui", `page loaded ${location.href} · ${navigator.userAgent.slice(0, 120)} · ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`);
}
