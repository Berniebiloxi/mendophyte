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

// ---- who holds the port when nothing answers as Mendophyte? -----------------

import { readFile, readdir, readlink } from "node:fs/promises";
import { execFile } from "node:child_process";

export interface PortHolder {
  pid: number;
  /** Command line when readable, else the process name, else null. */
  command: string | null;
  /** True when the command line looks like a Mendophyte server (stuck older instance). */
  looksLikeMendophyte: boolean;
}

function exec(file: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout))));
}

async function commandLine(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`);
      const s = raw.toString("utf8").replace(/\0+$/, "").split("\0").join(" ");
      if (s) return s;
    } catch {
      /* fall through */
    }
  }
  if (process.platform !== "win32") {
    const out = (await exec("ps", ["-o", "args=", "-p", String(pid)])).trim();
    return out || null;
  }
  const out = await exec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
  const m = /^"([^"]+)"/.exec(out.trim());
  return m ? m[1] : null;
}

/** Linux without lsof: match the listening socket's inode in /proc/net/tcp{,6} to a pid's fd table. */
async function linuxListenerPid(port: number): Promise<number | null> {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = await readFile(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // local_address rem_address st ... inode ; st 0A = LISTEN
      if (cols.length > 9 && cols[1].endsWith(`:${hexPort}`) && cols[3] === "0A") inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return null;
  let pids: string[] = [];
  try {
    pids = (await readdir("/proc")).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[] = [];
    try {
      fds = await readdir(`/proc/${pid}/fd`);
    } catch {
      continue; // other user's process
    }
    for (const fd of fds) {
      try {
        const target = await readlink(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m && inodes.has(m[1])) return Number(pid);
      } catch {
        /* fd vanished */
      }
    }
  }
  return null;
}

export async function findListener(port: number): Promise<PortHolder | null> {
  let pid: number | null = null;
  if (process.platform === "win32") {
    const out = await exec("netstat", ["-ano", "-p", "tcp"]);
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m && Number(m[1]) === port) {
        pid = Number(m[2]);
        break;
      }
    }
  } else {
    const out = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
    const m = /^p(\d+)/m.exec(out);
    if (m) pid = Number(m[1]);
    if (pid === null && process.platform === "linux") pid = await linuxListenerPid(port);
  }
  if (pid === null) return null;
  const command = await commandLine(pid);
  return { pid, command, looksLikeMendophyte: Boolean(command && /mendophyte|dist[\\/]cli\.js/i.test(command)) };
}

/** Terminates a process, escalating to SIGKILL, and waits for the port to free. */
export async function killHolder(holder: PortHolder, port: number, waitMs = 6000): Promise<boolean> {
  const sig = async (s: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") await exec("taskkill", ["/PID", String(holder.pid), "/T", "/F"]);
      else process.kill(holder.pid, s);
    } catch {
      /* already gone or not ours */
    }
  };
  await sig("SIGTERM");
  const deadline = Date.now() + waitMs;
  let escalated = false;
  while (Date.now() < deadline) {
    if (!(await findListener(port))) return true;
    if (!escalated && Date.now() > deadline - waitMs / 2) {
      escalated = true;
      await sig("SIGKILL");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return !(await findListener(port));
}
