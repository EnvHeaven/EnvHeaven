"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnExecution = spawnExecution;
exports.buildSpawnPlan = buildSpawnPlan;
exports.buildSpawnEnv = buildSpawnEnv;
exports.buildWindowsCommandLine = buildWindowsCommandLine;
const node_child_process_1 = require("node:child_process");
async function spawnExecution(request) {
    const spawnPlan = buildSpawnPlan(request, process.platform);
    return await spawnChild(spawnPlan.command, spawnPlan.args, request.env, request.cwd, spawnPlan.windowsCommandWrappingUsed);
}
function buildWslSpawnPlan(request) {
    const envArguments = Object.entries(request.env).flatMap(([key, value]) => ["env", `${key}=${value}`]);
    return {
        command: "wsl",
        args: [...envArguments, request.command, ...request.args],
        windowsCommandWrappingUsed: false,
    };
}
async function spawnChild(command, args, env, cwd, windowsCommandWrappingUsed = false) {
    return await new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, {
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
function shouldUseNativeWindowsSpawn(command) {
    const normalizedCommand = command.trim().toLowerCase();
    return normalizedCommand === "pnpm" || normalizedCommand === "pnpm.cmd" || normalizedCommand === "npm" || normalizedCommand === "npm.cmd";
}
function buildSpawnPlan(request, platform) {
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
function buildSpawnEnv(parentEnv, extraEnv, platform) {
    const mergedEnv = { ...parentEnv };
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
function buildWindowsCommandLine(command, args) {
    return [command, ...args.map((arg) => quoteWindowsArgument(arg))].join(" ");
}
function quoteWindowsArgument(value) {
    if (value.length === 0) {
        return "\"\"";
    }
    if (!/[ \t"&()^[\]{}=;!'+,`~]/.test(value)) {
        return value;
    }
    return `"${value.replace(/"/g, '\\"')}"`;
}
function shouldLogChildProcessDebug() {
    return process.env.EH_DEBUG_CHILD_PROCESS === "1" || process.env.ENVHEAVEN_DEBUG_CHILD_PROCESS === "1";
}
function logChildProcessDebug(phase, child, command, args, cwd, windowsCommandWrappingUsed, error) {
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
