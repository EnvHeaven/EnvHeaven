"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.launchOffilineWebUi = launchOffilineWebUi;
const node_child_process_1 = require("node:child_process");
const node_module_1 = require("node:module");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const spawn_1 = require("../execution/spawn");
const OFFLINE_UI_PACKAGE = "@envheaven/plugins-offline-web-ui";
const LEGACY_OFFILINE_UI_PACKAGE = "@envheaven/plugins-offiline-web-ui";
/**
 * Candidate relative paths (from repoRoot) where the offline-web-ui package may live.
 * Order matters — first match with a built dist wins.
 *
 * Path 1: running from inside envheaven-eh-env-eh-pkg-01/ (the package monorepo itself).
 * Path 2: running from the parent workspace root (e.g. replit-test-01/).
 */
const LOCAL_ARTIFACT_PATHS = [
    node_path_1.default.join("artifacts", "envheaven-pkg-plugin-offiline-web-ui-01"),
    node_path_1.default.join("artifacts", "envheaven-eh-env-eh-pkg-01", "artifacts", "envheaven-pkg-plugin-offiline-web-ui-01"),
];
async function launchOffilineWebUi(repoRoot, daemonUrl, store, port) {
    const resolved = await resolveOffilineWebUiSource(repoRoot, store);
    const localRequire = (0, node_module_1.createRequire)(node_path_1.default.join(resolved.requireRoot, "package.json"));
    const loaded = localRequire(resolved.moduleReference);
    const api = normalizeApi(loaded);
    if (!api?.startOffilineWebUiServer) {
        throw new Error(`Offline Web UI entry "${resolved.moduleReference}" does not expose startOffilineWebUiServer().`);
    }
    const started = await api.startOffilineWebUiServer({
        daemonUrl,
        ...(port !== undefined ? { port } : {}),
    });
    return {
        uiUrl: started.url,
        server: started.server,
        source: resolved.source,
    };
}
async function resolveOffilineWebUiSource(repoRoot, store) {
    // 1. Local workspace path — checked at multiple candidate locations so this works whether
    //    the user runs from inside envheaven-eh-env-eh-pkg-01/ or from its parent workspace root.
    for (const candidateRelPath of LOCAL_ARTIFACT_PATHS) {
        const localPackagePath = node_path_1.default.join(repoRoot, candidateRelPath);
        const localPackageJsonPath = node_path_1.default.join(localPackagePath, "package.json");
        const localDistEntryPath = node_path_1.default.join(localPackagePath, "dist", "server", "index.js");
        if (await exists(localPackageJsonPath)) {
            if (!await exists(localDistEntryPath)) {
                await runCommand("npm", ["run", "build"], localPackagePath);
            }
            if (await exists(localDistEntryPath)) {
                return {
                    requireRoot: localPackagePath,
                    moduleReference: localDistEntryPath,
                    source: "local-workspace",
                };
            }
        }
    }
    // 2. pnpm global install — populated by "envheaven deploy local"; works from any directory.
    const pnpmGlobalPath = await resolveFirstPnpmGlobalPackage([OFFLINE_UI_PACKAGE, LEGACY_OFFILINE_UI_PACKAGE]);
    if (pnpmGlobalPath) {
        const globalDistEntry = node_path_1.default.join(pnpmGlobalPath, "dist", "server", "index.js");
        if (await exists(globalDistEntry)) {
            return {
                requireRoot: pnpmGlobalPath,
                moduleReference: globalDistEntry,
                source: "local-workspace",
            };
        }
    }
    // 3. npm cache fallback — downloads from registry
    const installRoot = node_path_1.default.join(store.getPaths().toolsDirectory, "offline-web-ui");
    const packageName = await selectInstallablePackage([OFFLINE_UI_PACKAGE, LEGACY_OFFILINE_UI_PACKAGE]);
    const requireRoot = await ensureCachedPackage(installRoot, packageName);
    return {
        requireRoot,
        moduleReference: packageName,
        source: "user-cache",
    };
}
async function resolveFirstPnpmGlobalPackage(packageNames) {
    for (const packageName of packageNames) {
        const packagePath = await resolvePnpmGlobalPackage(packageName);
        if (packagePath && await exists(node_path_1.default.join(packagePath, "package.json"))) {
            return packagePath;
        }
    }
    return null;
}
async function resolvePnpmGlobalPackage(packageName) {
    return new Promise((resolve) => {
        const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
        (0, node_child_process_1.execFile)(pnpmCmd, ["root", "-g"], { timeout: 8000 }, (err, stdout) => {
            if (err || !stdout) {
                resolve(null);
                return;
            }
            const globalRoot = stdout.trim();
            if (!globalRoot) {
                resolve(null);
                return;
            }
            const packagePath = node_path_1.default.join(globalRoot, ...packageName.split("/"));
            resolve(packagePath);
        });
    });
}
async function selectInstallablePackage(packageNames) {
    for (const packageName of packageNames) {
        if (await npmPackageExists(packageName)) {
            return packageName;
        }
    }
    return packageNames[0] ?? OFFLINE_UI_PACKAGE;
}
async function npmPackageExists(packageName) {
    return new Promise((resolve) => {
        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
        (0, node_child_process_1.execFile)(npmCmd, ["view", packageName, "name"], { timeout: 8000 }, (err, stdout) => {
            resolve(!err && stdout.trim() === packageName);
        });
    });
}
async function ensureCachedPackage(installRoot, packageName) {
    const packageJsonPath = node_path_1.default.join(installRoot, "package.json");
    const installedPackageJsonPath = node_path_1.default.join(installRoot, "node_modules", ...packageName.split("/"), "package.json");
    await node_fs_1.promises.mkdir(installRoot, { recursive: true });
    if (!await exists(packageJsonPath)) {
        await node_fs_1.promises.writeFile(packageJsonPath, `${JSON.stringify({ private: true, name: "envheaven-offline-web-ui-cache" }, null, 2)}\n`, "utf8");
    }
    if (!await exists(installedPackageJsonPath)) {
        await runCommand("npm", ["install", "--no-package-lock", "--prefix", installRoot, packageName], installRoot);
    }
    return installRoot;
}
function normalizeApi(value) {
    if (typeof value.startOffilineWebUiServer === "function") {
        return value;
    }
    if (value.default && typeof value.default.startOffilineWebUiServer === "function") {
        return value.default;
    }
    return null;
}
async function exists(filePath) {
    try {
        await node_fs_1.promises.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function runCommand(command, args, cwd) {
    await new Promise((resolve, reject) => {
        const spawnPlan = process.platform === "win32"
            ? {
                command: "cmd.exe",
                args: ["/d", "/s", "/c", (0, spawn_1.buildWindowsCommandLine)(command, args)],
            }
            : {
                command,
                args,
            };
        const child = (0, node_child_process_1.spawn)(spawnPlan.command, spawnPlan.args, {
            cwd,
            env: process.env,
            stdio: "inherit",
            shell: false,
        });
        child.on("close", (exitCode) => {
            if ((exitCode ?? 1) === 0) {
                resolve();
                return;
            }
            reject(new Error(`Command "${command}" failed with exit code ${String(exitCode)}.`));
        });
        child.on("error", reject);
    });
}
