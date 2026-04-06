#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGlobalFlags } from "./cli-flags";
import { verboseLog, writeOutput } from "./cli-output";
import { inferCommandIntent } from "./commands/intent";
import { startDaemon } from "./daemon/server";
import {
  buildMissingProductionVersionDiagnostic,
  createArtifactDeployTag,
  readPackageMetadata,
  withPermanentPackageVersion,
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
import type {
  ArtifactExecutionPlan,
  CommandIntent,
  Diagnostic,
  ExecutionSpec,
  GlobalOptions,
  PluginRuntimeContext,
  RepoExecutionPlan,
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
            createDiagnostic("error", "json-request-missing", "--json-request requires a JSON string argument, e.g. '{\"kind\":\"run\",\"target\":\"local\"}'."),
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
  await stateStore.rememberRepo(repoRoot);

  if (intent.kind === "daemon") {
    const server = await startDaemon(repoRoot, 0, stateStore);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    writeOutput(
      {
        mode: "daemon",
        port,
        diagnostics: [
          createDiagnostic("info", "daemon-started", `EnvHeaven daemon started on port ${String(port)}.`),
          createDiagnostic("info", "offiline-web-ui-hint", "Hint: `envheaven offiline-web-ui` is an option."),
          createDiagnostic("info", "offiline-web-ui-tip", "Tip: run `envheaven offiline-web-ui` to install and launch the offline UI."),
        ],
      },
      0,
      options,
    );
    return;
  }

  if (intent.kind === "offiline-web-ui") {
    const daemonServer = await startDaemon(repoRoot, 0, stateStore);
    const daemonAddress = daemonServer.address();
    const daemonPort = typeof daemonAddress === "object" && daemonAddress ? daemonAddress.port : null;
    const daemonUrl = `http://127.0.0.1:${String(daemonPort)}`;
    const launched = await launchOffilineWebUi(repoRoot, daemonUrl, stateStore);
    installServerSignalHandlers([daemonServer, launched.server]);

    writeOutput(
      {
        mode: "offiline-web-ui",
        daemonUrl,
        uiUrl: launched.uiUrl,
        source: launched.source,
        diagnostics: [
          createDiagnostic("info", "daemon-started", `EnvHeaven daemon started on ${daemonUrl}.`),
          createDiagnostic("info", "offiline-web-ui-started", `EnvHeaven offiline web UI started at ${launched.uiUrl}.`),
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
      plan.artifactExecutions = plan.artifactExecutions.filter((entry) => selection.artifactNames.includes(entry.artifactName));
      plan.execution =
        plan.repoExecutions.find((repoExecution) => repoExecution.status === "runnable")?.execution ??
        plan.artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ?? null;
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
      plan.artifactExecutions = plan.artifactExecutions.filter((entry) => selection.artifactNames.includes(entry.artifactName));
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
          createDiagnostic(
            "error",
            "plugin-execute-missing",
            `Plugin "${plan.pluginPackage}" does not export execute().`,
          ),
        );
      } else {
        verboseLog("spawn started", options);
        const executed = await loadedPlugin.plugin.execute(plan, runtimeContext);
        verboseLog("spawn done", options);
        if (executed.diagnostics) {
          diagnostics.push(...executed.diagnostics);
        }

        executionResult = {
          exitCode: executed.exitCode,
          details: executed.details,
        };
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

function parseJsonRequestArg(jsonString: string): { intent: CommandIntent | null; diagnostics: Diagnostic[] } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonString) as Record<string, unknown>;
  } catch {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic("error", "json-request-parse-error", `--json-request argument is not valid JSON: ${jsonString}`),
      ],
    };
  }

  if (typeof parsed["kind"] !== "string") {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic("error", "json-request-missing-kind", '--json-request JSON must contain a "kind" field (e.g. "run", "deploy", "daemon").'),
      ],
    };
  }

  const kind = parsed["kind"] as CommandIntent["kind"];
  const supportedKinds = new Set(["daemon", "run", "deploy", "offiline-web-ui"]);
  if (!supportedKinds.has(kind)) {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic("error", "json-request-invalid-kind", `--json-request "kind" must be one of: daemon, run, deploy, offiline-web-ui. Got: "${kind}".`),
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

function installServerSignalHandlers(servers: Array<{ close(callback: (error?: Error | undefined) => void): void }>): void {
  const closeAll = () => {
    for (const server of servers) {
      server.close(() => undefined);
    }
  };

  process.once("SIGINT", closeAll);
  process.once("SIGTERM", closeAll);
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
    repoResults.push({
      name: repoExecution.name,
      status: repoExecution.status,
      result,
    });
    if ((result.exitCode ?? 0) !== 0) {
      exitCode = result.exitCode as number;
      return {
        exitCode,
        payload: {
          repoExecutions: repoResults,
          artifactExecutions: artifactResults,
        },
      };
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

  return {
    exitCode,
    payload: {
      repoExecutions: repoResults,
      artifactExecutions: artifactResults,
    },
  };
}

async function hydrateArtifactExecution(
  artifactExecution: ArtifactExecutionPlan,
  repoRoot: string,
  diagnostics: Diagnostic[],
  stateStore: EnvHeavenStateStore,
  deployTarget: string,
): Promise<ExecutionSpec | null> {
  if (!artifactExecution.execution) {
    return null;
  }

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
    env: {
      ...hydratedExecution.env,
      EH_ARTIFACT_VERSION: resolvedVersion.value,
    },
  };

  const applyVersion = isLocalGlobalInstall_ ? withPermanentPackageVersion : withTemporaryPackageVersion;
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
      const tagResult = await createArtifactDeployTag(runtimeContext.repoRoot, packageDirectory, resolvedVersion.value, deployTarget);
      payload.tag = tagResult;
      if (tagResult.message) {
        diagnostics.push(createDiagnostic("warning", "artifact-tag-warning", tagResult.message));
      }
    }
  }

  return {
    exitCode: (result.exitCode as number) ?? 1,
    payload,
  };
}

function materializeDynamicVersionToken(value: string, artifactName: string, resolvedVersion: string): string {
  if (value === "dynamic-artifact-version") {
    return resolvedVersion;
  }

  return value.replace(
    /\{\{\s*GetDynamicArtifactVersionOf\('([^']+)'\)\s*\}\}/g,
    (_match, tokenArtifactName: string) => tokenArtifactName === artifactName ? resolvedVersion : _match,
  );
}

async function executePlanItem(
  name: string,
  execution: ExecutionSpec | null,
  runtimeContext: PluginRuntimeContext,
  diagnostics: Diagnostic[],
): Promise<Record<string, unknown>> {
  if (!execution) {
    return { skipped: true, exitCode: 0 };
  }

  if (execution.pluginPackage) {
    const loadedPlugin = await loadPlugin(execution.pluginPackage, runtimeContext.repoRoot);
    diagnostics.push(...loadedPlugin.diagnostics);
    if (loadedPlugin.plugin.inspect) {
      const inspected = await loadedPlugin.plugin.inspect(runtimeContext);
      if (inspected.diagnostics) {
        diagnostics.push(...inspected.diagnostics);
      }
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
        targetResolutionTrace: ["default"],
        mergeOrder: [],
        selectedArtifacts: [],
        diagnostics,
        trace: [],
        repoExecutions: [],
        artifactExecutions: [],
        execution,
        pluginPackage: execution.pluginPackage,
        resolvedModel: {},
      },
      runtimeContext,
    );
    if (executed.diagnostics) {
      diagnostics.push(...executed.diagnostics);
    }

    return {
      name,
      exitCode: executed.exitCode,
      details: executed.details,
    };
  }

  const spawned = await runtimeContext.spawnExecution({
    command: execution.command ?? "",
    args: execution.args,
    env: execution.env,
    cwd: execution.cwd,
  });

  if (spawned.exitCode !== 0) {
    diagnostics.push(
      createDiagnostic("error", "deploy-step-failed", `Deploy step "${name}" failed with exit code ${String(spawned.exitCode)}.`),
    );
  }

  return {
    name,
    exitCode: spawned.exitCode,
    signal: spawned.signal,
  };
}
