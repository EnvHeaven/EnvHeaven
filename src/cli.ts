#!/usr/bin/env node
import { inferCommandIntent } from "./commands/intent";
import { startDaemon } from "./daemon/server";
import { createDiagnostic, hasErrors } from "./diagnostics";
import { discoverEnvRepo } from "./envrepo/discovery";
import { buildRepoModel } from "./envrepo/model";
import { resolvePlan } from "./envrepo/resolver";
import { spawnExecution } from "./execution/spawn";
import { loadPlugin } from "./plugins/loader";
import type { ArtifactExecutionPlan, Diagnostic, ExecutionSpec, PluginRuntimeContext, RepoExecutionPlan } from "./types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { intent, diagnostics: intentDiagnostics } = inferCommandIntent(args);

  if (!intent) {
    writeJsonAndExit({ diagnostics: intentDiagnostics }, 1);
    return;
  }

  if (intent.kind === "daemon") {
    const server = await startDaemon(process.cwd());
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    process.stdout.write(
      JSON.stringify(
        {
          mode: "daemon",
          port,
          diagnostics: [
            createDiagnostic("info", "daemon-started", `EnvHeaven daemon started on port ${String(port)}.`),
          ],
        },
        null,
        2,
      ) + "\n",
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

  const discovery = await discoverEnvRepo(process.cwd());
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, intent.target, intent.kind);
  const diagnostics: Diagnostic[] = [...intentDiagnostics, ...plan.diagnostics];

  const runtimeContext: PluginRuntimeContext = {
    repoRoot: process.cwd(),
    platform: process.platform,
    diagnostics,
    spawnExecution,
  };

  if (intent.kind === "deploy") {
    const deployResults = await executeDeployPlan(plan.repoExecutions, plan.artifactExecutions, runtimeContext, diagnostics);
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
    const loadedPlugin = await loadPlugin(plan.pluginPackage, process.cwd());
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
  repoExecutions: RepoExecutionPlan[],
  artifactExecutions: ArtifactExecutionPlan[],
  runtimeContext: PluginRuntimeContext,
  diagnostics: Diagnostic[],
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

  for (const repoExecution of repoExecutions) {
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

  for (const artifactExecution of artifactExecutions) {
    const result = await executePlanItem(
      artifactExecution.runnerName,
      artifactExecution.execution,
      runtimeContext,
      diagnostics,
    );
    artifactResults.push({
      artifactName: artifactExecution.artifactName,
      runnerName: artifactExecution.runnerName,
      status: artifactExecution.status,
      result,
    });
    if ((result.exitCode ?? 0) !== 0) {
      exitCode = result.exitCode as number;
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
