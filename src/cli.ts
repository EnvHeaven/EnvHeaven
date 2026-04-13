#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { parseGlobalFlags } from "./cli-flags";
import { verboseLog, writeOutput } from "./cli-output";
import { inferCommandIntent } from "./commands/intent";
import { startDaemon } from "./daemon/server";
import {
  buildMissingProductionVersionDiagnostic,
  createArtifactDeployTag,
  readPackageMetadata,
  stageAndPackLocal,
  withTemporaryPackageVersion,
} from "./deploy/runtime";
import { applyPnpmRecursiveFilter, isLocalGlobalInstall } from "./deploy/plan-filter";
import { resolveArtifactSelection } from "./deploy/selection";
import { createDiagnostic, hasErrors } from "./diagnostics";
import { discoverEnvRepo } from "./envrepo/discovery";
import { buildRepoModel } from "./envrepo/model";
import { resolvePlan } from "./envrepo/resolver";
import { resolveWorkspaceRoot } from "./envrepo/workspace-routing";
import { spawnExecution } from "./execution/spawn";
import { extractPortFromExecution, killPortHolder } from "./execution/port-utils";
import {
  buildChallengeFromResolvedModel,
  executeCliChallenge,
} from "./guards/challenge";
import { launchOffilineWebUi } from "./offiline/launcher";
import { loadPlugin } from "./plugins/loader";
import { EnvHeavenStateStore } from "./state/store";
import { loadPreferences, savePreferences } from "./state/preferences";
import { readLockFile, writeLockFile, clearLockFile, isPortOpen, waitForLockFile } from "./state/lock";
import type {
  ArtifactExecutionPlan,
  CommandIntent,
  Diagnostic,
  ExecutionSpec,
  GlobalOptions,
  PluginRuntimeContext,
  ResolvedPlan,
  SupportedTarget,
} from "./types";

const PACKAGE_VERSION: string = (() => {
  const store = new EnvHeavenStateStore();
  const installed = store.readInstalledCliVersionSync();
  if (installed) return installed;
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  } catch {
    return "0.1.0";
  }
})();

const BG_MODE = process.env["ENVHEAVEN_BG_MODE"] === "1";

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const { options, remainingArgs } = parseGlobalFlags(rawArgs);
  verboseLog("flags parsed", options);

  if (options.version) {
    process.stdout.write(`EnvHeaven v${PACKAGE_VERSION}\n`);
    process.exitCode = 0;
    return;
  }

  let intentArgs = remainingArgs;
  let intent: CommandIntent | null = null;
  let intentDiagnostics: Diagnostic[] = [];

  if (options.jsonRequest) {
    const jsonArg = remainingArgs.find((a) => a.trimStart().startsWith("{"));
    if (!jsonArg) {
      writeOutput(
        {
          diagnostics: [
            createDiagnostic(
              "error",
              "json-request-missing",
              "--json-request requires a JSON string argument, e.g. '{\"kind\":\"run\",\"target\":\"local\"}'.",
            ),
          ],
        },
        1,
        options,
      );
      return;
    }
    const parsed = parseJsonRequestArg(jsonArg);
    if (!parsed.intent) {
      writeOutput({ diagnostics: parsed.diagnostics }, 1, options);
      return;
    }
    intent = parsed.intent;
    intentDiagnostics = [];
    intentArgs = [];
  } else {
    const inferred = inferCommandIntent(intentArgs);
    intent = inferred.intent ?? null;
    intentDiagnostics = inferred.diagnostics;
  }

  verboseLog("intent resolved", options);

  if (!intent) {
    writeOutput({ diagnostics: intentDiagnostics }, 1, options);
    return;
  }

  const workspaceResult = await resolveWorkspaceRoot(process.cwd());
  const repoRoot = workspaceResult.envRepoRoot;
  const stateStore = new EnvHeavenStateStore();
  const paths = stateStore.getPaths();
  await stateStore.rememberRepo(repoRoot);

  if (intent.kind === "daemon") {
    if (BG_MODE) {
      const { server, killAllRuns } = await startDaemon(repoRoot, 42990, stateStore, PACKAGE_VERSION);
      const address = server.address();
      const daemonPort = typeof address === "object" && address ? address.port : 0;

      let uiPort: number | null = null;
      const bgPrefs = await loadPreferences();
      if (bgPrefs?.autoStartUi) {
        try {
          const launched = await launchOffilineWebUi(repoRoot, `http://127.0.0.1:${String(daemonPort)}`, stateStore, 42991);
          const uiAddr = launched.server.address();
          uiPort = typeof uiAddr === "object" && uiAddr ? uiAddr.port : null;
        } catch {
          // non-fatal
        }
      }

      await writeLockFile(paths, {
        daemonPort,
        uiPort,
        startedAt: new Date().toISOString(),
        daemonPid: process.pid,
        uiPid: uiPort !== null ? process.pid : undefined,
      });

      process.once("SIGTERM", () => {
        killAllRuns();
        void clearLockFile(paths).then(() => server.close(() => process.exit(0)));
      });
      process.once("SIGINT", () => {
        killAllRuns();
        void clearLockFile(paths).then(() => server.close(() => process.exit(0)));
      });
      return;
    }

    // ── daemon subcommand handling (stop / restart / status) ──────────────
    if (intent.subcommand === "status" || intent.subcommand === "stop" || intent.subcommand === "restart") {
      const lock = await readLockFile(paths);
      const alive = !!(lock && lock.daemonPort > 0 && (await isPortOpen(lock.daemonPort)));

      if (intent.subcommand === "status") {
        writeOutput(
          {
            mode: "daemon",
            running: alive,
            port: alive ? lock!.daemonPort : null,
            uiPort: alive && lock!.uiPort ? lock!.uiPort : null,
            diagnostics: [
              createDiagnostic(
                "info",
                alive ? "daemon-running" : "daemon-stopped",
                alive
                  ? `Service running on port ${String(lock!.daemonPort)}.`
                  : "Service is not running.",
              ),
            ],
          },
          0,
          options,
        );
        return;
      }

      if (!alive) {
        const msg = intent.subcommand === "restart" ? "Service is not running — starting fresh." : "Service is not running.";
        if (intent.subcommand === "stop") {
          writeOutput({ diagnostics: [createDiagnostic("info", "daemon-already-stopped", msg)] }, 0, options);
          return;
        }
        // restart with no running daemon → fall through to start
      } else {
        if (intent.subcommand === "stop" && !options.jsonRequest && process.stdin.isTTY) {
          const confirmed = await promptConfirm("Service is running. Stop it? (y/N) ");
          if (!confirmed) {
            writeOutput({ diagnostics: [createDiagnostic("info", "daemon-stop-cancelled", "Stop cancelled.")] }, 0, options);
            return;
          }
        }
        // Stop the daemon via its PID
        const stopped = await killProcess(lock!.daemonPid ?? null, lock!.daemonPort);
        if (!stopped) {
          writeOutput(
            { diagnostics: [createDiagnostic("error", "daemon-stop-failed", "Service did not stop within 5 seconds.")] },
            1,
            options,
          );
          return;
        }
        await clearLockFile(paths);
        if (intent.subcommand === "stop") {
          writeOutput(
            { diagnostics: [createDiagnostic("info", "daemon-stopped", "Service stopped.")] },
            0,
            options,
          );
          return;
        }
        // restart: fall through to start logic below (after this if-block)
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    let prefs = await loadPreferences();
    if (prefs === null) {
      const autoStart = await promptYesNo(
        "  EnvHeaven — first-run setup\n" +
          "  ─────────────────────────────────────────\n" +
          "  Start the Offline GUI automatically each time? (Y/n) ",
      );
      await savePreferences({ autoStartUi: autoStart });
      prefs = { autoStartUi: autoStart };
      process.stdout.write(
        autoStart
          ? "  Saved: the Offline GUI will auto-start with the service.\n"
          : "  Saved: Offline GUI will not auto-start (run `envheaven offiline-web-ui` anytime).\n",
      );
    }

    const existingLock = await readLockFile(paths);
    const daemonAlive = !!(existingLock && existingLock.daemonPort > 0 && (await isPortOpen(existingLock.daemonPort)));

    if (daemonAlive) {
      const uiAlreadyUp = !!(existingLock!.uiPort && existingLock!.uiPort > 0 && (await isPortOpen(existingLock!.uiPort)));

      if (prefs.autoStartUi && !uiAlreadyUp) {
        // Daemon alive but UI missing — spawn UI-only
        const uiChild = spawn(
          process.execPath,
          [process.argv[1]!, "offiline-web-ui"],
          {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
            env: {
              ...process.env,
              ENVHEAVEN_BG_MODE: "1",
              ENVHEAVEN_UI_ONLY_DAEMON_PORT: String(existingLock!.daemonPort),
            },
          },
        );
        uiChild.unref();

        const uiLock = await waitForLockFile(paths, 18000, 300, true);
        const lanIp = getLanIp();
        writeOutput(
          {
            mode: "daemon",
            already_running: true,
            port: existingLock!.daemonPort,
            daemonUrls: buildUrlList(existingLock!.daemonPort, lanIp),
            uiUrls: uiLock?.uiPort ? buildUrlList(uiLock.uiPort, lanIp) : [],
            diagnostics: [
              createDiagnostic("info", "daemon-already-running", `EnvHeaven service already running on port ${String(existingLock!.daemonPort)}.`),
              ...(uiLock?.uiPort
                ? [createDiagnostic("info", "offiline-web-ui-started", `EnvHeaven Offline GUI started on port ${String(uiLock.uiPort)}.`)]
                : []),
            ],
          },
          0,
          options,
        );
        return;
      }

      const lanIp = getLanIp();
      writeOutput(
        {
          mode: "daemon",
          already_running: true,
          port: existingLock!.daemonPort,
          daemonUrls: buildUrlList(existingLock!.daemonPort, lanIp),
          uiUrls: existingLock!.uiPort ? buildUrlList(existingLock!.uiPort, lanIp) : [],
          diagnostics: [
            createDiagnostic("info", "daemon-already-running", `EnvHeaven service already running on port ${String(existingLock!.daemonPort)}.`),
          ],
        },
        0,
        options,
      );
      return;
    }

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ENVHEAVEN_BG_MODE: "1" },
    });
    child.unref();

    const requireUi = prefs.autoStartUi === true;
    const lock = await waitForLockFile(paths, 18000, 300, requireUi);
    if (!lock) {
      writeOutput(
        { diagnostics: [createDiagnostic("error", "daemon-start-timeout", "EnvHeaven service did not become reachable within 18 seconds.")] },
        1,
        options,
      );
      return;
    }

    const lanIp = getLanIp();
    writeOutput(
      {
        mode: "daemon",
        port: lock.daemonPort,
        daemonUrls: buildUrlList(lock.daemonPort, lanIp),
        uiUrls: lock.uiPort ? buildUrlList(lock.uiPort, lanIp) : [],
        diagnostics: [
          createDiagnostic("info", "daemon-started", `EnvHeaven service started on port ${String(lock.daemonPort)}.`),
          ...(lock.uiPort
            ? [createDiagnostic("info", "offiline-web-ui-started", `EnvHeaven Offline GUI started on port ${String(lock.uiPort)}.`)]
            : [createDiagnostic("info", "offiline-web-ui-hint", "Tip: run `envheaven offiline-web-ui` to launch the Offline GUI.")]),
        ],
      },
      0,
      options,
    );
    return;
  }

  if (intent.kind === "version") {
    process.stdout.write(`EnvHeaven v${PACKAGE_VERSION}\n`);
    process.exitCode = 0;
    return;
  }

  if (intent.kind === "offiline-web-ui") {
    if (BG_MODE) {
      const uiOnlyDaemonPortStr = process.env["ENVHEAVEN_UI_ONLY_DAEMON_PORT"];

      if (uiOnlyDaemonPortStr) {
        // Reuse existing daemon — only start UI
        const existingDaemonPort = parseInt(uiOnlyDaemonPortStr, 10);
        const launched = await launchOffilineWebUi(repoRoot, `http://127.0.0.1:${String(existingDaemonPort)}`, stateStore, 42991);
        const uiAddress = launched.server.address();
        const uiPort = typeof uiAddress === "object" && uiAddress ? uiAddress.port : null;

        // Update lock file to record uiPort (daemon port and PID preserved)
        const existingLockForPid = await readLockFile(paths);
        await writeLockFile(paths, {
          daemonPort: existingDaemonPort,
          uiPort: uiPort ?? null,
          startedAt: new Date().toISOString(),
          daemonPid: existingLockForPid?.daemonPid,
          uiPid: process.pid,
        });

        process.once("SIGTERM", () => {
          // On UI-only shutdown: null out uiPort in lock but leave daemon entry intact
          void writeLockFile(paths, { daemonPort: existingDaemonPort, uiPort: null, startedAt: new Date().toISOString() })
            .then(() => launched.server.close(() => process.exit(0)));
        });
        process.once("SIGINT", () => {
          void writeLockFile(paths, { daemonPort: existingDaemonPort, uiPort: null, startedAt: new Date().toISOString() })
            .then(() => launched.server.close(() => process.exit(0)));
        });
        return;
      }

      // Full mode: start daemon + UI
      const { server: daemonServer, killAllRuns: killDaemonRuns } = await startDaemon(repoRoot, 42990, stateStore, PACKAGE_VERSION);
      const daemonAddress = daemonServer.address();
      const daemonPort = typeof daemonAddress === "object" && daemonAddress ? daemonAddress.port : 0;

      const launched = await launchOffilineWebUi(repoRoot, `http://127.0.0.1:${String(daemonPort)}`, stateStore, 42991);
      const uiAddress = launched.server.address();
      const uiPort = typeof uiAddress === "object" && uiAddress ? uiAddress.port : null;

      await writeLockFile(paths, {
        daemonPort,
        uiPort: uiPort ?? null,
        startedAt: new Date().toISOString(),
        daemonPid: process.pid,
        uiPid: process.pid,
      });

      const cleanup = () => {
        killDaemonRuns();
        void clearLockFile(paths).then(() => {
          daemonServer.close(() => undefined);
          launched.server.close(() => process.exit(0));
        });
      };
      process.once("SIGTERM", cleanup);
      process.once("SIGINT", cleanup);
      return;
    }

    // Check per-service if already running
    const existingLock = await readLockFile(paths);
    const daemonAliveUi = !!(existingLock && existingLock.daemonPort > 0 && (await isPortOpen(existingLock.daemonPort)));
    const uiAlive = !!(daemonAliveUi && existingLock!.uiPort && existingLock!.uiPort > 0 && (await isPortOpen(existingLock!.uiPort)));

    if (daemonAliveUi && uiAlive) {
      const lanIp = getLanIp();
      writeOutput(
        {
          mode: "offiline-web-ui",
          already_running: true,
          daemonUrls: buildUrlList(existingLock!.daemonPort, lanIp),
          uiUrls: buildUrlList(existingLock!.uiPort!, lanIp),
          diagnostics: [createDiagnostic("info", "already-running", "EnvHeaven service and Offline GUI are already running.")],
        },
        0,
        options,
      );
      return;
    }

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ENVHEAVEN_BG_MODE: "1" };
    if (daemonAliveUi && !uiAlive) {
      // Daemon running, only launch missing UI
      spawnEnv["ENVHEAVEN_UI_ONLY_DAEMON_PORT"] = String(existingLock!.daemonPort);
    }

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: spawnEnv,
    });
    child.unref();

    const lock = await waitForLockFile(paths, 18000, 300, true);
    if (!lock) {
      writeOutput(
        { diagnostics: [createDiagnostic("error", "offiline-web-ui-start-timeout", "EnvHeaven Offline GUI did not become reachable within 18 seconds.")] },
        1,
        options,
      );
      return;
    }

    const lanIp = getLanIp();
    writeOutput(
      {
        mode: "offiline-web-ui",
        daemonUrls: buildUrlList(lock.daemonPort, lanIp),
        uiUrls: lock.uiPort ? buildUrlList(lock.uiPort, lanIp) : [],
        diagnostics: [
          ...(daemonAliveUi
            ? [createDiagnostic("info", "daemon-reused", `EnvHeaven service reused on port ${String(lock.daemonPort)}.`)]
            : [createDiagnostic("info", "daemon-started", `EnvHeaven service started on port ${String(lock.daemonPort)}.`)]),
          createDiagnostic("info", "offiline-web-ui-started", `EnvHeaven Offline GUI started on port ${String(lock.uiPort ?? 0)}.`),
        ],
      },
      0,
      options,
    );
    return;
  }

  // ── ui [stop|restart|status] ──────────────────────────────────────────
  if (intent.kind === "ui") {
    const lock = await readLockFile(paths);
    const uiAlive = !!(lock && lock.uiPort && lock.uiPort > 0 && (await isPortOpen(lock.uiPort)));
    const daemonAlive = !!(lock && lock.daemonPort > 0 && (await isPortOpen(lock.daemonPort)));

    if (intent.subcommand === "status") {
      writeOutput(
        {
          mode: "ui",
          running: uiAlive,
          uiPort: uiAlive ? lock!.uiPort : null,
          daemonPort: daemonAlive ? lock!.daemonPort : null,
          diagnostics: [
            createDiagnostic(
              "info",
              uiAlive ? "ui-running" : "ui-stopped",
              uiAlive
                ? `Offline GUI running on port ${String(lock!.uiPort)}.`
                : "Offline GUI is not running.",
            ),
          ],
        },
        0,
        options,
      );
      return;
    }

    if (intent.subcommand === "stop" || intent.subcommand === "restart") {
      if (!uiAlive) {
        if (intent.subcommand === "stop") {
          writeOutput({ diagnostics: [createDiagnostic("info", "ui-already-stopped", "Offline GUI is not running.")] }, 0, options);
          return;
        }
        // restart with UI not running → fall through to start
      } else {
        const stopped = await killProcess(lock!.uiPid ?? null, lock!.uiPort!, 6000, lock!.daemonPort);
        if (!stopped) {
          writeOutput(
            { diagnostics: [createDiagnostic("error", "ui-stop-failed", "Offline GUI did not stop within 5 seconds.")] },
            1,
            options,
          );
          return;
        }
        // Clear uiPort from lock file (preserve daemonPort)
        await writeLockFile(paths, {
          daemonPort: lock!.daemonPort,
          uiPort: null,
          startedAt: lock!.startedAt,
          daemonPid: lock!.daemonPid,
          uiPid: undefined,
        });
        if (intent.subcommand === "stop") {
          writeOutput({ diagnostics: [createDiagnostic("info", "ui-stopped", "Offline GUI stopped.")] }, 0, options);
          return;
        }
        // restart: fall through to start below
      }
    }

    // No subcommand (or restart after stop): start the UI.
    // This is the same logic as the offiline-web-ui start path.
    const existingLock2 = await readLockFile(paths);
    const daemonAlive2 = !!(existingLock2 && existingLock2.daemonPort > 0 && (await isPortOpen(existingLock2.daemonPort)));
    const uiAlive2 = !!(daemonAlive2 && existingLock2!.uiPort && existingLock2!.uiPort > 0 && (await isPortOpen(existingLock2!.uiPort)));

    if (daemonAlive2 && uiAlive2 && !intent.subcommand) {
      const lanIp = getLanIp();
      writeOutput(
        {
          mode: "ui",
          already_running: true,
          daemonUrls: buildUrlList(existingLock2!.daemonPort, lanIp),
          uiUrls: buildUrlList(existingLock2!.uiPort!, lanIp),
          diagnostics: [createDiagnostic("info", "already-running", "EnvHeaven service and Offline GUI are already running.")],
        },
        0,
        options,
      );
      return;
    }

    const spawnEnv2: NodeJS.ProcessEnv = { ...process.env, ENVHEAVEN_BG_MODE: "1" };
    if (daemonAlive2 && !uiAlive2) {
      spawnEnv2["ENVHEAVEN_UI_ONLY_DAEMON_PORT"] = String(existingLock2!.daemonPort);
    }

    const uiChild = spawn(process.execPath, [process.argv[1], "offiline-web-ui"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: spawnEnv2,
    });
    uiChild.unref();

    const uiLock = await waitForLockFile(paths, 18000, 300, true);
    if (!uiLock) {
      writeOutput(
        { diagnostics: [createDiagnostic("error", "ui-start-timeout", "Offline GUI did not become reachable within 18 seconds.")] },
        1,
        options,
      );
      return;
    }

    const lanIp = getLanIp();
    writeOutput(
      {
        mode: "ui",
        daemonUrls: buildUrlList(uiLock.daemonPort, lanIp),
        uiUrls: uiLock.uiPort ? buildUrlList(uiLock.uiPort, lanIp) : [],
        diagnostics: [createDiagnostic("info", "ui-started", `Offline GUI started on port ${String(uiLock.uiPort ?? 0)}.`)],
      },
      0,
      options,
    );
    return;
  }
  // ──────────────────────────────────────────────────────────────────────

  if (intent.kind === "apply" && intent.subcommand === "version") {
    const discovery = await discoverEnvRepo(repoRoot);
    const repoModel = buildRepoModel(discovery);
    const versionRecords = await stateStore.getVersionRecords(repoRoot);
    const applyResults: Array<{ artifactName: string; packageName?: string; version: string; packageJsonPath: string; applied: boolean; error?: string }> = [];
    const applyDiagnostics: Diagnostic[] = [...intentDiagnostics];

    for (const record of versionRecords) {
      const targetVersion = record.nextVersion ?? record.lastVersion;
      if (!targetVersion) continue;

      const artifactConfig = repoModel.artifacts[record.artifactName];
      let pkgDir: string | undefined;
      if (artifactConfig && typeof artifactConfig["RepoCloneFolderPath"] === "string") {
        pkgDir = path.resolve(repoRoot, artifactConfig["RepoCloneFolderPath"] as string);
      }
      if (!pkgDir) {
        const candidates = discovery.files
          .filter((f) => f.fileName === "package.json" && f.payload && (f.payload as Record<string, unknown>)["name"] === record.packageName)
          .map((f) => path.dirname(f.sourcePath));
        pkgDir = candidates[0];
      }
      if (!pkgDir) continue;

      const packageJsonPath = path.join(pkgDir, "package.json");
      try {
        const raw = readFileSync(packageJsonPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        parsed.version = targetVersion;
        const { promises: fsAsync } = await import("node:fs");
        await fsAsync.writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        applyResults.push({ artifactName: record.artifactName, packageName: record.packageName, version: targetVersion, packageJsonPath, applied: true });
        applyDiagnostics.push(createDiagnostic("info", "version-applied", `Applied version "${targetVersion}" to ${packageJsonPath}.`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        applyResults.push({ artifactName: record.artifactName, packageName: record.packageName, version: targetVersion, packageJsonPath, applied: false, error: msg });
        applyDiagnostics.push(createDiagnostic("warning", "version-apply-failed", `Failed to apply version to ${packageJsonPath}: ${msg}`));
      }
    }

    writeOutput({ intent, applyResults, diagnostics: applyDiagnostics }, hasErrors(applyDiagnostics) ? 1 : 0, options);
    return;
  }

  if (!intent.target) {
    writeOutput(
      {
        diagnostics: [
          ...intentDiagnostics,
          createDiagnostic("error", "intent-target-missing", "Command intent is missing a supported target."),
        ],
      },
      1,
      options,
    );
    return;
  }

  verboseLog("repo discovery started", options);
  const discovery = await discoverEnvRepo(repoRoot);
  verboseLog("repo discovery done", options);

  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, intent.target, intent.kind as "run" | "deploy");
  verboseLog("plan resolved", options);

  const diagnostics: Diagnostic[] = [...intentDiagnostics, ...plan.diagnostics];

  const runtimeContext: PluginRuntimeContext = {
    repoRoot,
    platform: process.platform,
    diagnostics,
    spawnExecution,
  };

  if (intent.kind === "run") {
    const selection = resolveArtifactSelection(plan.artifactExecutions, intent.artifactSelectors ?? []);
    diagnostics.push(...selection.diagnostics);
    if (!hasErrors(diagnostics)) {
      plan.selectedArtifacts = selection.artifactNames;
      plan.artifactExecutions = plan.artifactExecutions.filter((entry) =>
        selection.artifactNames.includes(entry.artifactName),
      );
      plan.execution =
        plan.repoExecutions.find((repoExecution) => repoExecution.status === "runnable")?.execution ??
        plan.artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ??
        null;
      plan.pluginPackage = plan.execution?.pluginPackage;
    }

    const runnableArtifacts = plan.artifactExecutions.filter(
      (a) => a.status === "runnable" && a.execution,
    );

    for (const entry of runnableArtifacts) {
      const exec = entry.execution!;
      const port = extractPortFromExecution(exec.args, exec.env);
      if (port) {
        const portResult = await killPortHolder(port);
        if (portResult.wasInUse && portResult.killed) {
          diagnostics.push(
            createDiagnostic(
              "warning",
              "port-conflict-resolved",
              `Port ${String(port)} was in use (PID ${String(portResult.pid ?? "?")}) — process terminated before starting.`,
            ),
          );
        } else if (portResult.wasInUse && !portResult.killed) {
          diagnostics.push(
            createDiagnostic(
              "error",
              "port-conflict-unresolved",
              `Port ${String(port)} is in use and could not be freed. Please stop the process manually.`,
            ),
          );
          writeOutput({ intent, plan, diagnostics }, 1, options);
          return;
        }
      }
    }

    if (plan.repoExecutions.length > 0) {
      const deployResults = await executeDeployPlan(plan, runtimeContext, diagnostics, stateStore, options);
      verboseLog("output written", options);
      writeOutput(
        { intent, plan, deploy: deployResults.payload, deploySummary: deployResults.deploySummary, diagnostics },
        hasErrors(diagnostics) ? 1 : deployResults.exitCode,
        options,
      );
      return;
    }

    if (runnableArtifacts.length > 1 && !hasErrors(diagnostics)) {
      for (const entry of runnableArtifacts) {
        const exec = entry.execution!;
        const port = extractPortFromExecution(exec.args, exec.env);
        const artifactMeta = repoModel.artifacts[entry.artifactName] as Record<string, unknown> | undefined;
        const publicName = (artifactMeta?.PublicName ?? artifactMeta?.publicName ?? entry.artifactName) as string;
        const url = port ? `http://localhost:${String(port)}/` : null;
        process.stdout.write(`  [starting] ${publicName}${url ? ` — ${url}` : ""}\n`);
      }

      const pluginCache = new Map<string, Awaited<ReturnType<typeof loadPlugin>>>();
      const promises = runnableArtifacts.map(async (entry) => {
        const exec = entry.execution!;
        const pkg = exec.pluginPackage;
        if (!pkg) {
          const spawnResult = await spawnExecution({
            command: exec.command!,
            args: exec.args,
            env: exec.env,
            cwd: exec.cwd,
          });
          return spawnResult.exitCode;
        }
        let loaded = pluginCache.get(pkg);
        if (!loaded) {
          loaded = await loadPlugin(pkg, repoRoot);
          pluginCache.set(pkg, loaded);
        }
        if (loaded.plugin.execute) {
          const singlePlan: ResolvedPlan = {
            ...plan,
            execution: exec,
            pluginPackage: pkg,
          };
          const result = await loaded.plugin.execute(singlePlan, runtimeContext);
          return result.exitCode ?? 1;
        }
        return 1;
      });

      const results = await Promise.all(promises);
      const exitCode = results.some((c) => c !== 0) ? 1 : 0;
      writeOutput({ intent, plan, diagnostics }, exitCode, options);
      return;
    }
  }

  if (intent.kind === "deploy") {
    const challengeRequirement = buildChallengeFromResolvedModel(
      plan.resolvedModel,
      plan.resolvedTarget,
    );

    if (challengeRequirement) {
      if (options.jsonResponse) {
        diagnostics.push(
          createDiagnostic(
            "error",
            "challenge-required-non-interactive",
            `Deploy to "${plan.resolvedTarget}" requires interactive confirmation (challenge: "${challengeRequirement.phrase}"). ` +
              `Cannot proceed in JSON/non-interactive mode.`,
          ),
        );
        writeOutput({ intent, plan, diagnostics }, 1, options);
        return;
      }

      const challengeResult = await executeCliChallenge(challengeRequirement);
      diagnostics.push(...challengeResult.diagnostics);
      if (!challengeResult.passed) {
        writeOutput({ intent, plan, diagnostics }, 1, options);
        return;
      }
    }

    const selection = resolveArtifactSelection(plan.artifactExecutions, intent.artifactSelectors ?? []);
    diagnostics.push(...selection.diagnostics);
    if (!hasErrors(diagnostics)) {
      plan.selectedArtifacts = selection.artifactNames;
      plan.artifactExecutions = plan.artifactExecutions.filter((entry) =>
        selection.artifactNames.includes(entry.artifactName),
      );
      plan.execution =
        plan.repoExecutions.find((repoExecution) => repoExecution.status === "runnable")?.execution ??
        plan.artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ??
        null;
    }

    const deployResults = await executeDeployPlan(plan, runtimeContext, diagnostics, stateStore, options);
    const exitCode = hasErrors(diagnostics) ? 1 : deployResults.exitCode;

    verboseLog("output written", options);
    writeOutput(
      { intent, plan, deploy: deployResults.payload, deploySummary: deployResults.deploySummary, diagnostics },
      exitCode,
      options,
    );
    return;
  }

  let pluginDetails: Record<string, unknown> | undefined;
  let executionResult: Record<string, unknown> | undefined;

  if (plan.pluginPackage) {
    verboseLog(`plugin load: ${plan.pluginPackage}`, options);
    const loadedPlugin = await loadPlugin(plan.pluginPackage, repoRoot);
    verboseLog(`plugin loaded: ${plan.pluginPackage}`, options);
    diagnostics.push(...loadedPlugin.diagnostics);

    if (loadedPlugin.plugin.inspect) {
      const inspected = await loadedPlugin.plugin.inspect(runtimeContext);
      if (inspected.diagnostics) {
        diagnostics.push(...inspected.diagnostics);
      }
      pluginDetails = inspected.details;
    }

    if (!hasErrors(diagnostics)) {
      if (!loadedPlugin.plugin.execute) {
        diagnostics.push(
          createDiagnostic("error", "plugin-execute-missing", `Plugin "${plan.pluginPackage}" does not export execute().`),
        );
      } else {
        verboseLog("spawn started", options);
        const executed = await loadedPlugin.plugin.execute(plan, runtimeContext);
        verboseLog("spawn done", options);
        if (executed.diagnostics) {
          diagnostics.push(...executed.diagnostics);
        }
        executionResult = { exitCode: executed.exitCode, details: executed.details };
      }
    }
  }

  const exitCode = hasErrors(diagnostics)
    ? 1
    : typeof executionResult?.exitCode === "number"
      ? (executionResult.exitCode as number)
      : 0;

  verboseLog("output written", options);
  writeOutput(
    { intent, plan, plugin: pluginDetails, execution: executionResult, diagnostics },
    exitCode,
    options,
  );
}

async function promptYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      // (Y/n) semantics: empty or non-"n" resolves to true
      resolve(trimmed !== "n" && trimmed !== "no");
    });
  });
}

function parseJsonRequestArg(jsonString: string): { intent: CommandIntent | null; diagnostics: Diagnostic[] } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonString) as Record<string, unknown>;
  } catch {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic(
          "error",
          "json-request-parse-error",
          `--json-request argument is not valid JSON: ${jsonString}`,
        ),
      ],
    };
  }

  if (typeof parsed["kind"] !== "string") {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic(
          "error",
          "json-request-missing-kind",
          '--json-request JSON must contain a "kind" field (e.g. "run", "deploy", "service").',
        ),
      ],
    };
  }

  const kind = parsed["kind"] as CommandIntent["kind"];
  const kindAlias: Record<string, string> = { service: "daemon" };
  const resolvedKind = kindAlias[kind] ?? kind;
  const supportedKinds = new Set(["daemon", "run", "deploy", "offiline-web-ui", "apply"]);
  if (!supportedKinds.has(resolvedKind)) {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic(
          "error",
          "json-request-invalid-kind",
          `--json-request "kind" must be one of: service, run, deploy, offiline-web-ui. Got: "${kind}".`,
        ),
      ],
    };
  }

  const target = typeof parsed["target"] === "string" ? (parsed["target"] as SupportedTarget) : undefined;
  const selectors = Array.isArray(parsed["selectors"]) ? (parsed["selectors"] as string[]) : undefined;

  return {
    intent: {
      kind: resolvedKind as CommandIntent["kind"],
      target,
      rawArgs: [jsonString],
      normalizedTokens: [resolvedKind, ...(target ? [target] : [])],
      artifactSelectors: selectors,
    },
    diagnostics: [],
  };
}

async function killProcess(
  pid: number | null,
  port: number,
  timeoutMs = 6000,
  shutdownApiPort?: number,
): Promise<boolean> {
  // Phase 1 — SIGTERM by PID if available
  if (pid !== null) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }

  // Phase 2 — HTTP shutdown endpoint (daemon API port, works for new daemons)
  const apiPort = shutdownApiPort ?? port;
  try {
    await fetch(`http://127.0.0.1:${apiPort}/daemon/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(1500),
    });
  } catch { /* endpoint may not exist on old daemons */ }

  // Phase 3 — OS-level fallback: find PID via fuser and send SIGTERM
  if (pid === null) {
    try {
      const { execFileSync } = await import("node:child_process");
      const raw = execFileSync("fuser", [`${port}/tcp`], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      for (const token of raw.split(/\s+/).filter(Boolean)) {
        const fuserPid = Number(token);
        if (fuserPid > 0) {
          try { process.kill(fuserPid, "SIGTERM"); } catch { /* already dead */ }
        }
      }
    } catch { /* fuser not available or no matching process */ }
  }

  // Phase 4 — poll until port closes
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }

  // Phase 5 — last resort SIGKILL
  if (pid !== null) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  } else {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
    } catch { /* fuser not available */ }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  return !(await isPortOpen(port));
}

function getLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function buildUrlList(port: number | null, lanIp: string | null): string[] {
  if (port === null) return [];
  const urls = [`http://localhost:${String(port)}`, `http://127.0.0.1:${String(port)}`];
  if (lanIp) {
    urls.push(`http://${lanIp}:${String(port)}`);
  }
  return urls;
}

void main().catch((error) => {
  const diagnostics = [
    createDiagnostic("error", "cli-failure", error instanceof Error ? error.message : "Unknown CLI failure."),
  ];
  process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
  process.exitCode = 1;
});

interface DeploySummaryEntry {
  artifactName: string;
  packageName: string;
  lastVersion: string | null;
  newVersion: string | null;
}

async function executeDeployPlan(
  plan: ResolvedPlan,
  runtimeContext: PluginRuntimeContext,
  diagnostics: Diagnostic[],
  stateStore: EnvHeavenStateStore,
  options: GlobalOptions,
): Promise<{
  exitCode: number;
  payload: {
    repoExecutions: Array<Record<string, unknown>>;
    artifactExecutions: Array<Record<string, unknown>>;
  };
  deploySummary: DeploySummaryEntry[];
}> {
  const repoResults: Array<Record<string, unknown>> = [];
  const artifactResults: Array<Record<string, unknown>> = [];
  const deploySummary: DeploySummaryEntry[] = [];
  let exitCode = 0;

  for (const repoExecution of plan.repoExecutions) {
    verboseLog(`deploy step start: ${repoExecution.name}`, options);
    const filteredExecution = applyPnpmRecursiveFilter(repoExecution.execution, plan.artifactExecutions, plan.selectedArtifacts);
    const result = await executePlanItem(repoExecution.name, filteredExecution, runtimeContext, diagnostics);
    verboseLog(`deploy step done: ${repoExecution.name} (exit ${String(result["exitCode"] ?? 0)})`, options);
    repoResults.push({ name: repoExecution.name, status: repoExecution.status, result });
    if ((result.exitCode ?? 0) !== 0) {
      exitCode = result.exitCode as number;
      return { exitCode, payload: { repoExecutions: repoResults, artifactExecutions: artifactResults }, deploySummary };
    }
  }

  for (const artifactExecution of plan.artifactExecutions) {
    verboseLog(`deploy step start: ${artifactExecution.runnerName}`, options);
    const existingRecord = await stateStore.getVersionRecord(
      runtimeContext.repoRoot,
      artifactExecution.artifactName,
      artifactExecution.packageName,
    );
    const lastVersionBefore = existingRecord?.lastVersion ?? null;

    const hydrated = await hydrateArtifactExecution(
      artifactExecution,
      runtimeContext.repoRoot,
      diagnostics,
      stateStore,
      plan.resolvedTarget,
    );
    const result = await executeArtifactDeploy(
      artifactExecution,
      hydrated.execution,
      hydrated.resolvedVersion,
      runtimeContext,
      diagnostics,
      stateStore,
      plan.resolvedTarget,
    );
    verboseLog(`deploy step done: ${artifactExecution.runnerName} (exit ${String(result.exitCode)})`, options);
    artifactResults.push(result.payload);

    if (result.exitCode === 0) {
      deploySummary.push({
        artifactName: artifactExecution.artifactName,
        packageName: (result.payload["packageName"] as string) ?? artifactExecution.packageName ?? artifactExecution.artifactName,
        lastVersion: lastVersionBefore,
        newVersion: hydrated.resolvedVersion,
      });
    }

    if (result.exitCode !== 0) {
      exitCode = result.exitCode;
      break;
    }
  }

  return { exitCode, payload: { repoExecutions: repoResults, artifactExecutions: artifactResults }, deploySummary };
}

async function hydrateArtifactExecution(
  artifactExecution: ArtifactExecutionPlan,
  repoRoot: string,
  diagnostics: Diagnostic[],
  stateStore: EnvHeavenStateStore,
  deployTarget: string,
): Promise<{ execution: ExecutionSpec | null; resolvedVersion: string }> {
  if (!artifactExecution.execution) return { execution: null, resolvedVersion: "0.1.0" };

  const packageDirectory = artifactExecution.repoCloneFolderPath
    ? path.resolve(repoRoot, artifactExecution.repoCloneFolderPath)
    : artifactExecution.execution.cwd;

  const existingRecord = await stateStore.getVersionRecord(
    repoRoot,
    artifactExecution.artifactName,
    artifactExecution.packageName,
  );

  let resolvedVersionValue: string;

  if (existingRecord?.nextVersion) {
    resolvedVersionValue = existingRecord.nextVersion;
  } else if (existingRecord?.lastVersion) {
    resolvedVersionValue = existingRecord.lastVersion;
  } else {
    let packageJsonVersion = "0.1.0";
    if (packageDirectory) {
      try {
        const packageMetadata = await readPackageMetadata(packageDirectory);
        packageJsonVersion = packageMetadata.version;
      } catch {
        packageJsonVersion = "0.1.0";
      }
    }

    const { record } = await stateStore.bootstrapArtifactVersion(
      repoRoot,
      artifactExecution.artifactName,
      artifactExecution.packageName,
      packageJsonVersion,
    );
    resolvedVersionValue = record.nextVersion ?? record.lastVersion ?? packageJsonVersion;
    diagnostics.push(
      createDiagnostic(
        "info",
        "version-bootstrapped",
        `Artifact "${artifactExecution.artifactName}" version initialized to "${resolvedVersionValue}" (derived from package.json "${packageJsonVersion}").`,
      ),
    );
  }

  return {
    execution: {
      ...artifactExecution.execution,
      args: artifactExecution.execution.args.map((arg) =>
        materializeDynamicVersionToken(arg, artifactExecution.artifactName, resolvedVersionValue),
      ),
      env: Object.fromEntries(
        Object.entries(artifactExecution.execution.env).map(([key, value]) => [
          key,
          materializeDynamicVersionToken(value, artifactExecution.artifactName, resolvedVersionValue),
        ]),
      ),
    },
    resolvedVersion: resolvedVersionValue,
  };
}

async function executeArtifactDeploy(
  artifactExecution: ArtifactExecutionPlan,
  hydratedExecution: ExecutionSpec | null,
  hydratedVersion: string,
  runtimeContext: PluginRuntimeContext,
  diagnostics: Diagnostic[],
  stateStore: EnvHeavenStateStore,
  deployTarget: string,
): Promise<{ exitCode: number; payload: Record<string, unknown> }> {
  if (!hydratedExecution) {
    return {
      exitCode: 1,
      payload: {
        artifactName: artifactExecution.artifactName,
        runnerName: artifactExecution.runnerName,
        status: artifactExecution.status,
        result: { exitCode: 1, skipped: true },
      },
    };
  }

  const isProductionPublish =
    deployTarget === "production-01" &&
    hydratedExecution.command === "npm" &&
    hydratedExecution.args[0] === "publish";
  const isLocalGlobalInstall_ = isLocalGlobalInstall(hydratedExecution.command, hydratedExecution.args);
  const needsVersionedInstall = isProductionPublish || isLocalGlobalInstall_;

  const packageDirectory = artifactExecution.repoCloneFolderPath
    ? path.resolve(runtimeContext.repoRoot, artifactExecution.repoCloneFolderPath)
    : hydratedExecution.cwd;

  if (!needsVersionedInstall || !packageDirectory) {
    const result = await executePlanItem(artifactExecution.runnerName, hydratedExecution, runtimeContext, diagnostics);
    return {
      exitCode: (result.exitCode as number) ?? 1,
      payload: {
        artifactName: artifactExecution.artifactName,
        runnerName: artifactExecution.runnerName,
        status: artifactExecution.status,
        result,
      },
    };
  }

  const packageMetadata = await readPackageMetadata(packageDirectory);
  const resolvedVersionValue = hydratedVersion;

  const executionToRun: ExecutionSpec = {
    ...hydratedExecution,
    env: { ...hydratedExecution.env, EH_ARTIFACT_VERSION: resolvedVersionValue },
  };

  let result: Record<string, unknown>;

  if (isLocalGlobalInstall_) {
    const persistentCacheDir = stateStore.getPaths().cacheDirectory;
    const staged = await stageAndPackLocal(packageDirectory, resolvedVersionValue, persistentCacheDir);
    try {
      const tarballArgs = executionToRun.args.map((arg) => {
        if (arg === packageDirectory || path.resolve(arg) === path.resolve(packageDirectory)) {
          return staged.tarballPath;
        }
        return arg;
      });
      const tarballExecution: ExecutionSpec = { ...executionToRun, args: tarballArgs };
      result = await executePlanItem(artifactExecution.runnerName, tarballExecution, runtimeContext, diagnostics);
    } finally {
      await staged.cleanup();
    }
  } else {
    result = await withTemporaryPackageVersion(packageDirectory, resolvedVersionValue, async () => {
      return await executePlanItem(artifactExecution.runnerName, executionToRun, runtimeContext, diagnostics);
    });
  }

  const payload: Record<string, unknown> = {
    artifactName: artifactExecution.artifactName,
    packageName: artifactExecution.packageName ?? packageMetadata.name,
    runnerName: artifactExecution.runnerName,
    status: artifactExecution.status,
    version: resolvedVersionValue,
    result,
  };

  if ((result.exitCode ?? 0) === 0) {
    const updatedVersion = await stateStore.advanceArtifactVersion(
      runtimeContext.repoRoot,
      artifactExecution.artifactName,
      artifactExecution.packageName ?? packageMetadata.name,
      resolvedVersionValue,
    );
    payload.versionRegistry = updatedVersion;

    const installedPackageName = artifactExecution.packageName ?? packageMetadata.name;
    if (installedPackageName === "envheaven") {
      await stateStore.writeInstalledCliVersion(resolvedVersionValue);
    }

    if (packageDirectory) {
      const tagResult = await createArtifactDeployTag(
        runtimeContext.repoRoot,
        packageDirectory,
        resolvedVersionValue,
        deployTarget,
      );
      payload.tag = tagResult;
      if (tagResult.message) {
        diagnostics.push(createDiagnostic("warning", "artifact-tag-warning", tagResult.message));
      }
    }
  }

  return { exitCode: (result.exitCode as number) ?? 1, payload };
}

function materializeDynamicVersionToken(value: string, artifactName: string, resolvedVersion: string): string {
  if (value === "dynamic-artifact-version") {
    return resolvedVersion;
  }
  return value.replace(
    /\{\{\s*GetDynamicArtifactVersionOf\('([^']+)'\)\s*\}\}/g,
    (_match, tokenArtifactName: string) =>
      tokenArtifactName === artifactName ? resolvedVersion : _match,
  );
}

async function executePlanItem(
  name: string,
  execution: ExecutionSpec | null,
  runtimeContext: PluginRuntimeContext,
  diagnostics: Diagnostic[],
): Promise<Record<string, unknown>> {
  if (!execution) return { skipped: true, exitCode: 0 };

  if (execution.pluginPackage) {
    const loadedPlugin = await loadPlugin(execution.pluginPackage, runtimeContext.repoRoot);
    diagnostics.push(...loadedPlugin.diagnostics);
    if (loadedPlugin.plugin.inspect) {
      const inspected = await loadedPlugin.plugin.inspect(runtimeContext);
      if (inspected.diagnostics) diagnostics.push(...inspected.diagnostics);
    }

    if (!loadedPlugin.plugin.execute) {
      diagnostics.push(
        createDiagnostic("error", "plugin-execute-missing", `Plugin "${execution.pluginPackage}" does not export execute().`),
      );
      return { exitCode: 1 };
    }

    const executed = await loadedPlugin.plugin.execute(
      {
        kind: "run",
        requestedTarget: "default",
        resolvedTarget: "default",
        targetResolutionTrace: [],
        mergeOrder: [],
        selectedArtifacts: [],
        diagnostics: [],
        trace: [],
        repoExecutions: [],
        artifactExecutions: [],
        execution,
        pluginPackage: execution.pluginPackage,
        resolvedModel: {},
      },
      runtimeContext,
    );

    if (executed.diagnostics) diagnostics.push(...executed.diagnostics);
    return { exitCode: executed.exitCode, details: executed.details };
  }

  if (!execution.command) return { skipped: true, exitCode: 0 };

  const result = await runtimeContext.spawnExecution({
    command: execution.command,
    args: execution.args,
    env: execution.env,
    cwd: execution.cwd,
  });

  return { exitCode: result.exitCode };
}
