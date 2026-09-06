import { diag } from "./diag.js";

/**
 * Native confirm/prompt, wrapped so the debug log explains the pause.
 * While a native dialog is open the browser's main thread is blocked, which
 * the long-task monitor otherwise reports as a multi-second stall with no
 * visible cause. These record what was asked and how long the person
 * took, so "slow: main thread blocked 2600ms" reads next to "dialog closed
 * after 2600ms".
 */
export function askConfirm(message: string): boolean {
  const t0 = performance.now();
  diag(`dialog confirm: "${message.slice(0, 120)}"`);
  const ok = window.confirm(message);
  diag(`dialog confirm ${ok ? "accepted" : "cancelled"} after ${Math.round(performance.now() - t0)}ms (the main thread is blocked while it is open)`);
  return ok;
}

export function askPrompt(message: string, defaultValue = ""): string | null {
  const t0 = performance.now();
  diag(`dialog prompt: "${message.slice(0, 120)}"`);
  const v = window.prompt(message, defaultValue);
  diag(`dialog prompt ${v === null ? "cancelled" : v.trim() ? "answered" : "left empty"} after ${Math.round(performance.now() - t0)}ms (the main thread is blocked while it is open)`);
  return v;
}
