import { spawn } from "node:child_process";
import type { SpawnRequest, SpawnResult } from "../types";

export async function spawnExecution(request: SpawnRequest): Promise<SpawnResult> {
  if (process.platform !== "win32") {
    return await spawnDirectly(request);
  }

  return shouldUseNativeWindowsSpawn(request.command)
    ? await spawnDirectly(request)
    : await spawnViaWsl(request);
}

async function spawnDirectly(request: SpawnRequest): Promise<SpawnResult> {
  return await spawnChild(request.command, request.args, request.env, request.cwd);
}

async function spawnViaWsl(request: SpawnRequest): Promise<SpawnResult> {
  const envArguments = Object.entries(request.env).flatMap(([key, value]) => ["env", `${key}=${value}`]);
  const args = [...envArguments, request.command, ...request.args];
  return await spawnChild("wsl", args, {}, request.cwd);
}

async function spawnChild(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? 1,
        signal,
      });
    });
  });
}

function shouldUseNativeWindowsSpawn(command: string): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  return normalizedCommand === "pnpm" || normalizedCommand === "pnpm.cmd" || normalizedCommand === "npm" || normalizedCommand === "npm.cmd";
}
