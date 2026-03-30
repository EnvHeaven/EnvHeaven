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
  return await spawnChild(resolveCommandForPlatform(request.command, process.platform), request.args, request.env, request.cwd);
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
      env: buildSpawnEnv(process.env, env, process.platform),
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

export function resolveCommandForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalizedCommand = command.trim().toLowerCase();

  if (platform !== "win32") {
    return command;
  }

  if (normalizedCommand === "pnpm") {
    return "pnpm.cmd";
  }

  if (normalizedCommand === "npm") {
    return "npm.cmd";
  }

  return command;
}

export function buildSpawnEnv(
  parentEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const mergedEnv: NodeJS.ProcessEnv = { ...parentEnv };

  for (const [key, value] of Object.entries(extraEnv)) {
    if (platform !== "win32") {
      mergedEnv[key] = value;
      continue;
    }

    const existingKey = Object.keys(mergedEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    mergedEnv[existingKey ?? key] = value;
  }

  return mergedEnv;
}
