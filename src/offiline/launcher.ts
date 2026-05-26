import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import type http from "node:http";
import { EnvHeavenStateStore } from "../state/store";
import { buildWindowsCommandLine } from "../execution/spawn";

const OFFLINE_UI_PACKAGE = "@envheaven/plugins-offline-web-ui";
const LEGACY_OFFILINE_UI_PACKAGE = "@envheaven/plugins-offiline-web-ui";

/**
 * Candidate relative paths (from repoRoot) where the offline-web-ui package may live.
 * Order matters — first match with a built dist wins.
 *
 * Path 1: running from inside envheaven-eh-env-eh-pkg-01/ (the package monorepo itself).
 * Path 2: running from the parent workspace root (e.g. replit-test-01/).
 */
const LOCAL_ARTIFACT_PATHS: readonly string[] = [
  path.join("artifacts", "envheaven-pkg-plugin-offiline-web-ui-01"),
  path.join("artifacts", "envheaven-eh-env-eh-pkg-01", "artifacts", "envheaven-pkg-plugin-offiline-web-ui-01"),
];

interface OffilineWebUiApi {
  startOffilineWebUiServer(options: {
    daemonUrl: string;
    host?: string;
    port?: number;
  }): Promise<{
    url: string;
    server: http.Server;
  }>;
}

interface OffilineWebUiModuleShape {
  startOffilineWebUiServer?: OffilineWebUiApi["startOffilineWebUiServer"];
  default?: {
    startOffilineWebUiServer?: OffilineWebUiApi["startOffilineWebUiServer"];
  };
}

export async function launchOffilineWebUi(
  repoRoot: string,
  daemonUrl: string,
  store: EnvHeavenStateStore,
  port?: number,
): Promise<{
  uiUrl: string;
  server: http.Server;
  source: "local-workspace" | "user-cache";
}> {
  const resolved = await resolveOffilineWebUiSource(repoRoot, store);
  const localRequire = createRequire(path.join(resolved.requireRoot, "package.json"));
  const loaded = localRequire(resolved.moduleReference) as OffilineWebUiModuleShape;
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

async function resolveOffilineWebUiSource(
  repoRoot: string,
  store: EnvHeavenStateStore,
): Promise<{
  requireRoot: string;
  moduleReference: string;
  source: "local-workspace" | "user-cache";
}> {
  // 1. Local workspace path — checked at multiple candidate locations so this works whether
  //    the user runs from inside envheaven-eh-env-eh-pkg-01/ or from its parent workspace root.
  for (const candidateRelPath of LOCAL_ARTIFACT_PATHS) {
    const localPackagePath = path.join(repoRoot, candidateRelPath);
    const localPackageJsonPath = path.join(localPackagePath, "package.json");
    const localDistEntryPath = path.join(localPackagePath, "dist", "server", "index.js");

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
    const globalDistEntry = path.join(pnpmGlobalPath, "dist", "server", "index.js");
    if (await exists(globalDistEntry)) {
      return {
        requireRoot: pnpmGlobalPath,
        moduleReference: globalDistEntry,
        source: "local-workspace",
      };
    }
  }

  // 3. npm cache fallback — downloads from registry
  const installRoot = path.join(store.getPaths().toolsDirectory, "offline-web-ui");
  const packageName = await selectInstallablePackage([OFFLINE_UI_PACKAGE, LEGACY_OFFILINE_UI_PACKAGE]);
  const requireRoot = await ensureCachedPackage(installRoot, packageName);
  return {
    requireRoot,
    moduleReference: packageName,
    source: "user-cache",
  };
}

async function resolveFirstPnpmGlobalPackage(packageNames: readonly string[]): Promise<string | null> {
  for (const packageName of packageNames) {
    const packagePath = await resolvePnpmGlobalPackage(packageName);
    if (packagePath && await exists(path.join(packagePath, "package.json"))) {
      return packagePath;
    }
  }
  return null;
}

async function resolvePnpmGlobalPackage(packageName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    execFile(pnpmCmd, ["root", "-g"], { timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null);
        return;
      }
      const globalRoot = stdout.trim();
      if (!globalRoot) {
        resolve(null);
        return;
      }
      const packagePath = path.join(globalRoot, ...packageName.split("/"));
      resolve(packagePath);
    });
  });
}

async function selectInstallablePackage(packageNames: readonly string[]): Promise<string> {
  for (const packageName of packageNames) {
    if (await npmPackageExists(packageName)) {
      return packageName;
    }
  }
  return packageNames[0] ?? OFFLINE_UI_PACKAGE;
}

async function npmPackageExists(packageName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFile(npmCmd, ["view", packageName, "name"], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && stdout.trim() === packageName);
    });
  });
}

async function ensureCachedPackage(installRoot: string, packageName: string): Promise<string> {
  const packageJsonPath = path.join(installRoot, "package.json");
  const installedPackageJsonPath = path.join(installRoot, "node_modules", ...packageName.split("/"), "package.json");
  await fs.mkdir(installRoot, { recursive: true });

  if (!await exists(packageJsonPath)) {
    await fs.writeFile(
      packageJsonPath,
      `${JSON.stringify({ private: true, name: "envheaven-offline-web-ui-cache" }, null, 2)}\n`,
      "utf8",
    );
  }

  if (!await exists(installedPackageJsonPath)) {
    await runCommand("npm", ["install", "--no-package-lock", "--prefix", installRoot, packageName], installRoot);
  }

  return installRoot;
}

function normalizeApi(value: OffilineWebUiModuleShape): Partial<OffilineWebUiApi> | null {
  if (typeof value.startOffilineWebUiServer === "function") {
    return value;
  }

  if (value.default && typeof value.default.startOffilineWebUiServer === "function") {
    return value.default;
  }

  return null;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawnPlan =
      process.platform === "win32"
        ? {
            command: "cmd.exe",
            args: ["/d", "/s", "/c", buildWindowsCommandLine(command, args)],
          }
        : {
            command,
            args,
          };

    const child = spawn(spawnPlan.command, spawnPlan.args, {
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
