import { spawn } from "node:child_process";
import type { SpawnRequest, SpawnResult } from "../types";

export async function spawnExecution(request: SpawnRequest): Promise<SpawnResult> {
  const spawnPlan = buildSpawnPlan(request, process.platform);
  return await spawnChild(spawnPlan.command, spawnPlan.args, request.env, request.cwd, spawnPlan.windowsCommandWrappingUsed);
}

function buildWslSpawnPlan(request: SpawnRequest): SpawnPlan {
  const envArguments = Object.entries(request.env).flatMap(([key, value]) => ["env", `${key}=${value}`]);
  return {
    command: "wsl",
    args: [...envArguments, request.command, ...request.args],
    windowsCommandWrappingUsed: false,
  };
}

async function spawnChild(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
  windowsCommandWrappingUsed = false,
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildSpawnEnv(process.env, env, process.platform),
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (error) => {
      logChildProcessDebug("spawn-error", child, command, args, cwd, windowsCommandWrappingUsed, error);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if ((exitCode ?? 1) !== 0 || signal) {
        logChildProcessDebug("spawn-close", child, command, args, cwd, windowsCommandWrappingUsed);
      }

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

export function buildSpawnPlan(request: SpawnRequest, platform: NodeJS.Platform): SpawnPlan {
  if (platform !== "win32") {
    return {
      command: request.command,
      args: request.args,
      windowsCommandWrappingUsed: false,
    };
  }

  if (shouldUseNativeWindowsSpawn(request.command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", buildWindowsCommandLine(request.command, request.args)],
      windowsCommandWrappingUsed: true,
    };
  }

  return buildWslSpawnPlan(request);
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

export function buildWindowsCommandLine(command: string, args: string[]): string {
  return [command, ...args.map((arg) => quoteWindowsArgument(arg))].join(" ");
}

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) {
    return "\"\"";
  }

  if (!/[ \t"&()^[\]{}=;!'+,`~]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function shouldLogChildProcessDebug(): boolean {
  return process.env.EH_DEBUG_CHILD_PROCESS === "1" || process.env.ENVHEAVEN_DEBUG_CHILD_PROCESS === "1";
}

function logChildProcessDebug(
  phase: "spawn-error" | "spawn-close",
  child: ReturnType<typeof spawn>,
  command: string,
  args: string[],
  cwd: string | undefined,
  windowsCommandWrappingUsed: boolean,
  error?: Error,
): void {
  if (!shouldLogChildProcessDebug()) {
    return;
  }

  const payload = {
    phase,
    platform: process.platform,
    spawnExecutable: command,
    spawnArgs: args,
    cwd,
    windowsCommandWrappingUsed,
    spawnfile: child.spawnfile,
    spawnargs: child.spawnargs,
    error: error ? { message: error.message, name: error.name } : undefined,
  };

  console.error("[envheaven child-process debug]", JSON.stringify(payload, null, 2));
}

export interface SpawnPlan {
  command: string;
  args: string[];
  windowsCommandWrappingUsed: boolean;
}
