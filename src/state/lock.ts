import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { EnvHeavenPaths } from "./store";

export interface RunLockFile {
  daemonPort: number;
  uiPort: number | null;
  startedAt: string;
  daemonPid?: number;
  uiPid?: number;
}

export function getLockFilePath(paths: EnvHeavenPaths): string {
  return path.join(paths.stateDirectory, "running.lock.json");
}

export async function readLockFile(paths: EnvHeavenPaths): Promise<RunLockFile | null> {
  try {
    const raw = await fs.readFile(getLockFilePath(paths), "utf8");
    const parsed = JSON.parse(raw) as Partial<RunLockFile>;
    if (typeof parsed.daemonPort !== "number") return null;
    return {
      daemonPort: parsed.daemonPort,
      uiPort: typeof parsed.uiPort === "number" ? parsed.uiPort : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
      daemonPid: typeof parsed.daemonPid === "number" ? parsed.daemonPid : undefined,
      uiPid: typeof parsed.uiPid === "number" ? parsed.uiPid : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeLockFile(paths: EnvHeavenPaths, lock: RunLockFile): Promise<void> {
  const lockPath = getLockFilePath(paths);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}

export async function clearLockFile(paths: EnvHeavenPaths): Promise<void> {
  try {
    await fs.unlink(getLockFilePath(paths));
  } catch {
    // ignore if already gone
  }
}

export function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

/**
 * Poll until lock file exists and daemon port is reachable.
 * Pass requireUiPort=true to also wait until uiPort is present and reachable.
 */
export async function waitForLockFile(
  paths: EnvHeavenPaths,
  timeoutMs = 18000,
  pollIntervalMs = 300,
  requireUiPort = false,
): Promise<RunLockFile | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readLockFile(paths);
    if (lock && lock.daemonPort > 0 && (await isPortOpen(lock.daemonPort))) {
      if (!requireUiPort) return lock;
      if (lock.uiPort && lock.uiPort > 0 && (await isPortOpen(lock.uiPort))) return lock;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}
