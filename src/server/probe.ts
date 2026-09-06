/**
 * Talking to a Mendophyte instance that may already own the port, so a
 * restart after `git pull` doesn't end in "port already in use".
 */

export interface ExistingInstance {
  url: string;
  pid: number | null;
  version: string | null;
  startedAt: string | null;
  sessions: number | null;
}

/** Returns the running instance on this port if it answers as Mendophyte, `null` if nothing answers, `"other"` if something else does. */
export async function probeInstance(port: number, timeoutMs = 1500): Promise<ExistingInstance | null | "other"> {
  const url = `http://localhost:${port}`;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "other";
    const j: any = await res.json().catch(() => null);
    if (!j || j.name !== "mendophyte") return "other";
    return { url, pid: typeof j.pid === "number" ? j.pid : null, version: j.version ?? null, startedAt: j.startedAt ?? null, sessions: typeof j.sessions === "number" ? j.sessions : null };
  } catch {
    return null;
  }
}

/** Asks the instance to shut down and waits until the port stops answering. */
export async function requestShutdown(port: number, waitMs = 8000): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/api/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) });
  } catch {
    /* it may have exited before responding */
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await probeInstance(port, 500)) === null) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return (await probeInstance(port, 500)) === null;
}
