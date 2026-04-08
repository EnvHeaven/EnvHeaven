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
  withTemporaryPackageVersion,
} from "./deploy/runtime";
import { applyPnpmRecursiveFilter, isLocalGlobalInstall } from "./deploy/plan-filter";
import { resolveArtifactSelection } from "./deploy/selection";
import { createDiagnostic, hasErrors } from "./diagnostics";
import { discoverEnvRepo } from "./envrepo/discovery";
import { buildRepoModel } from "./envrepo/model";
import { resolvePlan } from "./envrepo/resolver";
import { spawnExecution } from "./execution/spawn";
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
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  } catch {
    return "0.1.0";
  }
})();

const BG_MODE = process.env["ENVHEAVEN_BG_MODE"] === "1";

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

  const repoRoot = process.cwd();
  const stateStore = new EnvHeavenStateStore();
  const paths = stateStore.getPaths();
  await stateStore.rememberRepo(repoRoot);

  if (intent.kind === "daemon") {
    if (BG_MODE) {
      const server = await startDaemon(repoRoot, 0, stateStore, PACKAGE_VERSION);
      const address = server.address();
      const daemonPort = typeof address === "object" && address ? address.port : 0;

      let uiPort: number | null = null;
      const bgPrefs = await loadPreferences();
      if (bgPrefs?.autoStartUi) {
        try {
          const launched = await launchOffilineWebUi(repoRoot, `http://127.0.0.1:${String(daemonPort)}`, stateStore);
          const uiAddr = launched.server.address();
          uiPort = typeof uiAddr === "object" && uiAddr ? uiAddr.port : null;
        } catch {
          // non-fatal
        }
      }

      await writeLockFile(paths, { daemonPort, uiPort, startedAt: new Date().toISOString() });

      process.once("SIGTERM", () => {
        void clearLockFile(paths).then(() => server.close(() => process.exit(0)));
      });
      process.once("SIGINT", () => {
        void clearLockFile(paths).then(() => server.close(() => process.exit(0)));
      });
      return;
    }

    let prefs = await loadPreferences();
    if (prefs === null) {
      const autoStart = await promptYesNo(
        "  EnvHeaven — first-run setup\n" +
          "  ─────────────────────────────────────────\n" +
          "  Start the Offline UI automatically each time? (Y/n) ",
      );
      await savePreferences({ autoStartUi: autoStart });
      prefs = { autoStartUi: autoStart };
      process.stdout.write(
        autoStart
          ? "  Saved: the offline UI will auto-start with the daemon.\n"
          : "  Saved: offline UI will not auto-start (run `envheaven offiline-web-ui` anytime).\n",
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
              createDiagnostic("info", "daemon-already-running", `EnvHeaven daemon already running on port ${String(existingLock!.daemonPort)}.`),
              ...(uiLock?.uiPort
                ? [createDiagnostic("info", "offiline-web-ui-started", `EnvHeaven offline UI started on port ${String(uiLock.uiPort)}.`)]
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
            createDiagnostic("info", "daemon-already-running", `EnvHeaven daemon already running on port ${String(existingLock!.daemonPort)}.`),
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
        { diagnostics: [createDiagnostic("error", "daemon-start-timeout", "EnvHeaven daemon did not become reachable within 18 seconds.")] },
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
          createDiagnostic("info", "daemon-started", `EnvHeaven daemon started on port ${String(lock.daemonPort)}.`),
          ...(lock.uiPort
            ? [createDiagnostic("info", "offiline-web-ui-started", `EnvHeaven offline UI started on port ${String(lock.uiPort)}.`)]
            : [createDiagnostic("info", "offiline-web-ui-hint", "Tip: run `envheaven offiline-web-ui` to launch the offline UI.")]),
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
        const launched = await launchOffilineWebUi(repoRoot, `http://127.0.0.1:${String(existingDaemonPort)}`, stateStore);
        const uiAddress = launched.server.address();
        const uiPort = typeof uiAddress === "object" && uiAddress ? uiAddress.port : null;

        // Update lock file to record uiPort (daemon port preserved)
        await writeLockFile(paths, { daemonPort: existingDaemonPort, uiPort: uiPort ?? null, startedAt: new Date().toISOString() });

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
      const daemonServer = await startDaemon(repoRoot, 0, stateStore, PACKAGE_VERSION);
      const daemonAddress = daemonServer.address();
      const daemonPort = typeof daemonAddress === "object" && daemonAddress ? daemonAddress.port : 0;

      const launched = await launchOffilineWebUi(repoRoot, `http://127.0.0.1:${String(daemonPort)}`, stateStore);
      const uiAddress = launched.server.address();
      const uiPort = typeof uiAddress === "object" && uiAddress ? uiAddress.port : null;

      await writeLockFile(paths, { daemonPort, uiPort: uiPort ?? null, startedAt: new Date().toISOString() });

      const cleanup = () => {
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
          diagnostics: [createDiagnostic("info", "already-running", "EnvHeaven daemon and offline UI are already running.")],
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
        { diagnostics: [createDiagnostic("error", "offiline-web-ui-start-timeout", "EnvHeaven offline UI did not become reachable within 18 seconds.")] },
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
            ? [createDiagnostic("info", "daemon-reused", `EnvHeaven daemon reused on port ${String(lock.daemonPort)}.`)]
            : [createDiagnostic("info", "daemon-started", `EnvHeaven daemon started on port ${String(lock.daemonPort)}.`)]),
          createDiagnostic("info", "offiline-web-ui-started", `EnvHeaven offline UI started on port ${String(lock.uiPort ?? 0)}.`),
        ],
      },
      0,
      options,
    );
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
  const plan = resolvePlan(repoModel, intent.target, intent.kind);
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

    if (plan.repoExecutions.length > 0) {
      const deployResults = await executeDeployPlan(plan, runtimeContext, diagnostics, stateStore, options);
      verboseLog("output written", options);
      writeOutput(
        { intent, plan, deploy: deployResults.payload, diagnostics },
        hasErrors(diagnostics) ? 1 : deployResults.exitCode,
        options,
      );
      return;
    }
  }

  if (intent.kind === "deploy") {
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
      { intent, plan, deploy: deployResults.payload, diagnostics },
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
          '--json-request JSON must contain a "kind" field (e.g. "run", "deploy", "daemon").',
        ),
      ],
    };
  }

  const kind = parsed["kind"] as CommandIntent["kind"];
  const supportedKinds = new Set(["daemon", "run", "deploy", "offiline-web-ui"]);
  if (!supportedKinds.has(kind)) {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic(
          "error",
          "json-request-invalid-kind",
          `--json-request "kind" must be one of: daemon, run, deploy, offiline-web-ui. Got: "${kind}".`,
        ),
      ],
    };
  }

  const target = typeof parsed["target"] === "string" ? (parsed["target"] as SupportedTarget) : undefined;
  const selectors = Array.isArray(parsed["selectors"]) ? (parsed["selectors"] as string[]) : undefined;

  return {
    intent: {
      kind,
      target,
      rawArgs: [jsonString],
      normalizedTokens: [kind, ...(target ? [target] : [])],
      artifactSelectors: selectors,
    },
    diagnostics: [],
  };
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
}> {
  const repoResults: Array<Record<string, unknown>> = [];
  const artifactResults: Array<Record<string, unknown>> = [];
  let exitCode = 0;

  for (const repoExecution of plan.repoExecutions) {
    verboseLog(`deploy step start: ${repoExecution.name}`, options);
    const filteredExecution = applyPnpmRecursiveFilter(repoExecution.execution, plan.artifactExecutions, plan.selectedArtifacts);
    const result = await executePlanItem(repoExecution.name, filteredExecution, runtimeContext, diagnostics);
    verboseLog(`deploy step done: ${repoExecution.name} (exit ${String(result["exitCode"] ?? 0)})`, options);
    repoResults.push({ name: repoExecution.name, status: repoExecution.status, result });
    if ((result.exitCode ?? 0) !== 0) {
      exitCode = result.exitCode as number;
      return { exitCode, payload: { repoExecutions: repoResults, artifactExecutions: artifactResults } };
    }
  }

  for (const artifactExecution of plan.artifactExecutions) {
    verboseLog(`deploy step start: ${artifactExecution.runnerName}`, options);
    const hydratedExecution = await hydrateArtifactExecution(
      artifactExecution,
      runtimeContext.repoRoot,
      diagnostics,
      stateStore,
      plan.resolvedTarget,
    );
    const result = await executeArtifactDeploy(
      artifactExecution,
      hydratedExecution,
      runtimeContext,
      diagnostics,
      stateStore,
      plan.resolvedTarget,
    );
    verboseLog(`deploy step done: ${artifactExecution.runnerName} (exit ${String(result.exitCode)})`, options);
    artifactResults.push(result.payload);
    if (result.exitCode !== 0) {
      exitCode = result.exitCode;
      break;
    }
  }

  return { exitCode, payload: { repoExecutions: repoResults, artifactExecutions: artifactResults } };
}

async function hydrateArtifactExecution(
  artifactExecution: ArtifactExecutionPlan,
  repoRoot: string,
  diagnostics: Diagnostic[],
  stateStore: EnvHeavenStateStore,
  deployTarget: string,
): Promise<ExecutionSpec | null> {
  if (!artifactExecution.execution) return null;

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
  };
}

async function executeArtifactDeploy(
  artifactExecution: ArtifactExecutionPlan,
  hydratedExecution: ExecutionSpec | null,
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
  const resolvedVersion = await stateStore.resolveArtifactVersion(
    runtimeContext.repoRoot,
    artifactExecution.artifactName,
    artifactExecution.packageName ?? packageMetadata.name,
    packageMetadata.version,
  );

  if (resolvedVersion.source === "fallback") {
    diagnostics.push(buildMissingProductionVersionDiagnostic(artifactExecution.artifactName, packageMetadata.version));
  }

  const executionToRun: ExecutionSpec = {
    ...hydratedExecution,
    env: { ...hydratedExecution.env, EH_ARTIFACT_VERSION: resolvedVersion.value },
  };

  const applyVersion = withTemporaryPackageVersion;
  const result = await applyVersion(packageDirectory, resolvedVersion.value, async () => {
    return await executePlanItem(artifactExecution.runnerName, executionToRun, runtimeContext, diagnostics);
  });

  const payload: Record<string, unknown> = {
    artifactName: artifactExecution.artifactName,
    packageName: artifactExecution.packageName ?? packageMetadata.name,
    runnerName: artifactExecution.runnerName,
    status: artifactExecution.status,
    version: resolvedVersion.value,
    result,
  };

  if ((result.exitCode ?? 0) === 0) {
    const updatedVersion = await stateStore.advanceArtifactVersion(
      runtimeContext.repoRoot,
      artifactExecution.artifactName,
      artifactExecution.packageName ?? packageMetadata.name,
      resolvedVersion.value,
    );
    payload.versionRegistry = updatedVersion;

    if (packageDirectory) {
      const tagResult = await createArtifactDeployTag(
        runtimeContext.repoRoot,
        packageDirectory,
        resolvedVersion.value,
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
