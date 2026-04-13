import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";

export interface PortKillResult {
  port: number;
  wasInUse: boolean;
  killed: boolean;
  pid: number | null;
}

export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export function findPidOnPort(port: number): number | null {
  try {
    const raw = execFileSync("fuser", [`${port}/tcp`], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const pids = raw
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((n) => n > 0);
    return pids[0] ?? null;
  } catch {
    return null;
  }
}

export async function killPortHolder(port: number, timeoutMs = 4000): Promise<PortKillResult> {
  const inUse = await isPortInUse(port);
  if (!inUse) {
    return { port, wasInUse: false, killed: false, pid: null };
  }

  const pid = findPidOnPort(port);

  if (pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  } else {
    try {
      execFileSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
    } catch {
      /* fuser unavailable */
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) {
      return { port, wasInUse: true, killed: true, pid };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }

  if (pid !== null) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  } else {
    try {
      execFileSync("fuser", ["-k", "-9", `${port}/tcp`], { stdio: "ignore" });
    } catch {
      /* fuser unavailable */
    }
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  const stillInUse = await isPortInUse(port);
  return { port, wasInUse: true, killed: !stillInUse, pid };
}

export function extractPortFromExecution(
  args: string[],
  env: Record<string, string>,
): number | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (parsed > 0) return parsed;
    }
    const portMatch = /^--port[=:](\d+)$/.exec(args[i]!);
    if (portMatch) {
      const parsed = parseInt(portMatch[1]!, 10);
      if (parsed > 0) return parsed;
    }
  }

  const portEnvValue = env["PORT"] ?? env["port"];
  if (portEnvValue) {
    const parsed = parseInt(portEnvValue, 10);
    if (parsed > 0) return parsed;
  }

  return null;
}
