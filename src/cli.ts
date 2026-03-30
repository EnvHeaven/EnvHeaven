#!/usr/bin/env node
import { inferCommandIntent } from "./commands/intent";
import { startDaemon } from "./daemon/server";
import { createDiagnostic, hasErrors } from "./diagnostics";
import { discoverEnvRepo } from "./envrepo/discovery";
import { buildRepoModel } from "./envrepo/model";
import { resolvePlan } from "./envrepo/resolver";
import { spawnExecution } from "./execution/spawn";
import { loadPlugin } from "./plugins/loader";
import type { Diagnostic, PluginRuntimeContext } from "./types";

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
          createDiagnostic("error", "intent-target-missing", "Run intent is missing a supported target."),
        ],
      },
      1,
    );
    return;
  }

  const discovery = await discoverEnvRepo(process.cwd());
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, intent.target);
  const diagnostics: Diagnostic[] = [...intentDiagnostics, ...plan.diagnostics];

  let pluginDetails: Record<string, unknown> | undefined;
  let executionResult: Record<string, unknown> | undefined;

  if (plan.pluginPackage) {
    const loadedPlugin = await loadPlugin(plan.pluginPackage, process.cwd());
    diagnostics.push(...loadedPlugin.diagnostics);

    const runtimeContext: PluginRuntimeContext = {
      repoRoot: process.cwd(),
      platform: process.platform,
      diagnostics,
      spawnExecution,
    };

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
