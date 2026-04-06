import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import type http from "node:http";
import { EnvHeavenStateStore } from "../state/store";
import { buildWindowsCommandLine } from "../execution/spawn";

const OFFILINE_UI_PACKAGE = "@envheaven/plugins-offiline-web-ui";
const LOCAL_ARTIFACT_PATH = path.join("artifacts", "envheaven-pkg-plugin-offiline-web-ui-01");

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
    throw new Error(`Offiline web UI entry "${resolved.moduleReference}" does not expose startOffilineWebUiServer().`);
  }

  const started = await api.startOffilineWebUiServer({
    daemonUrl,
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
  const localPackagePath = path.join(repoRoot, LOCAL_ARTIFACT_PATH);
  const localPackageJsonPath = path.join(localPackagePath, "package.json");
  const localDistEntryPath = path.join(localPackagePath, "dist", "server", "index.js");

  if (await exists(localPackageJsonPath)) {
    if (!await exists(localDistEntryPath)) {
      await runCommand("pnpm", ["run", "build"], localPackagePath);
    }

    if (await exists(localDistEntryPath)) {
      return {
        requireRoot: localPackagePath,
        moduleReference: localDistEntryPath,
        source: "local-workspace",
      };
    }
  }

  const installRoot = path.join(store.getPaths().toolsDirectory, "offiline-web-ui");
  const requireRoot = await ensureCachedPackage(installRoot, OFFILINE_UI_PACKAGE);
  return {
    requireRoot,
    moduleReference: OFFILINE_UI_PACKAGE,
    source: "user-cache",
  };
}

async function ensureCachedPackage(installRoot: string, packageName: string): Promise<string> {
  const packageJsonPath = path.join(installRoot, "package.json");
  const installedPackageJsonPath = path.join(installRoot, "node_modules", ...packageName.split("/"), "package.json");
  await fs.mkdir(installRoot, { recursive: true });

  if (!await exists(packageJsonPath)) {
    await fs.writeFile(
      packageJsonPath,
      `${JSON.stringify({ private: true, name: "envheaven-offiline-web-ui-cache" }, null, 2)}\n`,
      "utf8",
    );
  }

  if (!await exists(installedPackageJsonPath)) {
    await runCommand("pnpm", ["add", "--dir", installRoot, packageName], installRoot);
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
