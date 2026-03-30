#!/usr/bin/env node
import path from "node:path";
import { inferCommandIntent } from "./commands/intent";
import { startDaemon } from "./daemon/server";
import {
  buildMissingProductionVersionDiagnostic,
  buildVersionFallbackDiagnostic,
  createArtifactDeployTag,
  readPackageMetadata,
  withTemporaryPackageVersion,
} from "./deploy/runtime";
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
  Diagnostic,
  ExecutionSpec,
  PluginRuntimeContext,
  RepoExecutionPlan,
  ResolvedPlan,
} from "./types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { intent, diagnostics: intentDiagnostics } = inferCommandIntent(args);

  if (!intent) {
    writeJsonAndExit({ diagnostics: intentDiagnostics }, 1);
    return;
  }

  const repoRoot = process.cwd();
  const stateStore = new EnvHeavenStateStore();
  await stateStore.rememberRepo(repoRoot);

  if (intent.kind === "daemon") {
    const server = await startDaemon(repoRoot, 0, stateStore);
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    writeJsonAndExit(
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

    writeJsonAndExit(
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
    );
    return;
  }

  if (!intent.target) {
    writeJsonAndExit(
      {
        diagnostics: [
          ...intentDiagnostics,
          createDiagnostic("error", "intent-target-missing", "Command intent is missing a supported target."),
        ],
      },
      1,
    );
    return;
  }

  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, intent.target, intent.kind);
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
        plan.artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ?? null;
      plan.pluginPackage = plan.execution?.pluginPackage;
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

    const deployResults = await executeDeployPlan(plan, runtimeContext, diagnostics, stateStore);
    const exitCode = hasErrors(diagnostics)
      ? 1
      : deployResults.exitCode;

    writeJsonAndExit(
      {
        intent,
        plan,
        deploy: deployResults.payload,
        diagnostics,
      },
      exitCode,
    );
    return;
  }

  let pluginDetails: Record<string, unknown> | undefined;
  let executionResult: Record<string, unknown> | undefined;

  if (plan.pluginPackage) {
    const loadedPlugin = await loadPlugin(plan.pluginPackage, repoRoot);
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
        const executed = await loadedPlugin.plugin.execute(plan, runtimeContext);
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

  writeJsonAndExit(
    {
      intent,
      plan,
      plugin: pluginDetails,
      execution: executionResult,
      diagnostics,
    },
    exitCode,
  );
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

function writeJsonAndExit(payload: unknown, exitCode: number): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

void main().catch((error) => {
  const diagnostics = [
    createDiagnostic("error", "cli-failure", error instanceof Error ? error.message : "Unknown CLI failure."),
  ];
  writeJsonAndExit({ diagnostics }, 1);
});

async function executeDeployPlan(
  plan: ResolvedPlan,
  runtimeContext: PluginRuntimeContext,
  diagnostics: Diagnostic[],
  stateStore: EnvHeavenStateStore,
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
    const result = await executePlanItem(repoExecution.name, repoExecution.execution, runtimeContext, diagnostics);
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
  let fallbackVersion = "0.1.0";

  if (packageDirectory) {
    try {
      const packageMetadata = await readPackageMetadata(packageDirectory);
      fallbackVersion = packageMetadata.version;
    } catch {
      fallbackVersion = "0.1.0";
    }
  }

  const resolvedVersion = await stateStore.resolveArtifactVersion(
    repoRoot,
    artifactExecution.artifactName,
    artifactExecution.packageName,
    fallbackVersion,
  );

  if (resolvedVersion.source === "fallback") {
    diagnostics.push(buildVersionFallbackDiagnostic(artifactExecution.artifactName, fallbackVersion));
  }

  return {
    ...artifactExecution.execution,
    args: artifactExecution.execution.args.map((arg) =>
      materializeDynamicVersionToken(arg, artifactExecution.artifactName, resolvedVersion.value),
    ),
    env: Object.fromEntries(
      Object.entries(artifactExecution.execution.env).map(([key, value]) => [
        key,
        materializeDynamicVersionToken(value, artifactExecution.artifactName, resolvedVersion.value),
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
        result: {
          exitCode: 1,
          skipped: true,
        },
      },
    };
  }

  const isProductionPublish =
    deployTarget === "production-01" &&
    hydratedExecution.command === "npm" &&
    hydratedExecution.args[0] === "publish";

  const packageDirectory = artifactExecution.repoCloneFolderPath
    ? path.resolve(runtimeContext.repoRoot, artifactExecution.repoCloneFolderPath)
    : hydratedExecution.cwd;

  if (!isProductionPublish || !packageDirectory) {
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

  const result = await withTemporaryPackageVersion(packageDirectory, resolvedVersion.value, async () => {
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
    return {
      skipped: true,
      exitCode: 0,
    };
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
      return {
        exitCode: 1,
      };
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
