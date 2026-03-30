import path from "node:path";
import { createDiagnostic, hasErrors } from "../diagnostics";
import type {
  Diagnostic,
  ExecutionSpec,
  MergeTraceEntry,
  RepoModel,
  ResolvedPlan,
  SupportedTarget,
} from "../types";

const ALLOWED_CONDITION_TYPES = new Set(["always-force", "only-if-full-setup-completion"]);

export function resolvePlan(repoModel: RepoModel, target: SupportedTarget): ResolvedPlan {
  const diagnostics: Diagnostic[] = [...repoModel.diagnostics];
  const trace: MergeTraceEntry[] = [];
  const initialTarget = resolveAlias(repoModel, target, diagnostics);
  const targetResolution = resolveConcreteTarget(repoModel, initialTarget, diagnostics);
  const mergeOrder = buildMergeOrder(repoModel, targetResolution.resolvedTarget, diagnostics);
  const resolvedModel: Record<string, unknown> = {};

  for (const layerName of mergeOrder) {
    const layerValue = repoModel.envMapLayers[layerName];
    if (!layerValue) {
      continue;
    }

    const source = findLayerSource(repoModel, layerName);
    mergeIntoResolvedModel(resolvedModel, layerValue, source, layerName, trace, "");
  }

  validateConditionTypes(resolvedModel, diagnostics, []);
  const execution = normalizeExecution(resolvedModel, repoModel.rootDirectory, diagnostics);
  const pluginPackage = execution?.pluginPackage;

  return {
    requestedTarget: target,
    resolvedTarget: targetResolution.resolvedTarget,
    targetResolutionTrace: targetResolution.trace,
    mergeOrder,
    diagnostics,
    trace,
    execution,
    pluginPackage,
    resolvedModel,
  };
}

function resolveConcreteTarget(
  repoModel: RepoModel,
  target: string,
  diagnostics: Diagnostic[],
): { resolvedTarget: string; trace: string[] } {
  const seen = new Set<string>();
  const trace: string[] = [target];
  let current = target;

  while (true) {
    if (seen.has(current)) {
      diagnostics.push(
        createDiagnostic("error", "target-cycle", `TargetName cycle detected at "${current}".`),
      );
      return {
        resolvedTarget: current,
        trace,
      };
    }

    seen.add(current);
    const layerValue = repoModel.envMapLayers[current];
    if (!layerValue) {
      return {
        resolvedTarget: current,
        trace,
      };
    }

    if (!(layerValue.Type === "fallback-list" && typeof layerValue.TargetName === "string")) {
      return {
        resolvedTarget: current,
        trace,
      };
    }

    const nextTarget = resolveAlias(repoModel, layerValue.TargetName, diagnostics);
    trace.push(nextTarget);
    current = nextTarget;
  }
}

function resolveAlias(repoModel: RepoModel, target: string, diagnostics: Diagnostic[]): string {
  const seen = new Set<string>();
  let current = target;

  while (repoModel.aliases[current]?.length) {
    if (seen.has(current)) {
      diagnostics.push(createDiagnostic("error", "alias-cycle", `Alias cycle detected at "${current}".`));
      break;
    }

    seen.add(current);
    current = repoModel.aliases[current][0];
  }

  return current;
}

function buildMergeOrder(repoModel: RepoModel, target: string, diagnostics: Diagnostic[]): string[] {
  const appliedOrder: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (layerName: string) => {
    const canonicalName = resolveConcreteTarget(
      repoModel,
      resolveAlias(repoModel, layerName, diagnostics),
      diagnostics,
    ).resolvedTarget;

    if (visited.has(canonicalName)) {
      return;
    }

    if (visiting.has(canonicalName)) {
      diagnostics.push(
        createDiagnostic("error", "fallback-cycle", `Fallback cycle detected at "${canonicalName}".`),
      );
      return;
    }

    const layerValue = repoModel.envMapLayers[canonicalName];
    if (!layerValue) {
      diagnostics.push(
        createDiagnostic(
          canonicalName === target ? "error" : "warning",
          "missing-layer",
          `Resolved layer "${canonicalName}" is not present in EnvMapLayers.`,
        ),
      );
      return;
    }

    visiting.add(canonicalName);
    const fallbacks = getFallbackList(repoModel, canonicalName, layerValue);
    for (const fallback of fallbacks) {
      visit(fallback);
    }
    visiting.delete(canonicalName);
    visited.add(canonicalName);
    appliedOrder.push(canonicalName);
  };

  visit(target);
  return appliedOrder;
}

function getFallbackList(
  repoModel: RepoModel,
  layerName: string,
  layerValue: Record<string, unknown>,
): string[] {
  const nestedFallbacks = normalizeStringArray(layerValue["fallback-list"] ?? layerValue.fallbackList);

  if (layerName === "default") {
    return [...repoModel.fallbackList, ...nestedFallbacks];
  }

  return nestedFallbacks;
}

function mergeIntoResolvedModel(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  layerSource: string,
  layerName: string,
  trace: MergeTraceEntry[],
  prefix: string,
): void {
  for (const [key, value] of Object.entries(source)) {
    const propertyPath = prefix ? `${prefix}.${key}` : key;
    if (key === "RunCommand" && "Execution" in target) {
      delete target.Execution;
    }

    if (key === "Execution" && "RunCommand" in target) {
      delete target.RunCommand;
    }

    const existing = target[key];

    if (isRecord(existing) && isRecord(value)) {
      trace.push({
        source: layerSource,
        layerName,
        propertyPath,
        action: "merge",
      });
      mergeIntoResolvedModel(existing, value, layerSource, layerName, trace, propertyPath);
      continue;
    }

    if (Array.isArray(value)) {
      trace.push({
        source: layerSource,
        layerName,
        propertyPath,
        action: "replace-array",
      });
      target[key] = value.map((entry) => deepClone(entry));
      continue;
    }

    trace.push({
      source: layerSource,
      layerName,
      propertyPath,
      action: key in target ? "override" : "set",
    });
    target[key] = deepClone(value);
  }
}

function validateConditionTypes(
  value: unknown,
  diagnostics: Diagnostic[],
  pathParts: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateConditionTypes(entry, diagnostics, [...pathParts, String(index)]));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const currentPath = pathParts.join(".");
  if (
    typeof value.Type === "string" &&
    pathParts.some((part) => part === "Condition" || part === "Conditions")
  ) {
    if (!ALLOWED_CONDITION_TYPES.has(value.Type)) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "unsupported-condition-type",
          `Unsupported Condition.Type "${value.Type}".`,
          currentPath || undefined,
        ),
      );
    }
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    validateConditionTypes(nestedValue, diagnostics, [...pathParts, key]);
  }
}

function normalizeExecution(
  resolvedModel: Record<string, unknown>,
  repoRoot: string,
  diagnostics: Diagnostic[],
): ExecutionSpec | null {
  const executionRecord = normalizeExecutionRecord(resolvedModel);
  if (!executionRecord) {
    diagnostics.push(
      createDiagnostic("error", "execution-missing", "Resolved target does not expose Execution or RunCommand."),
    );
    return null;
  }

  if (hasErrors(diagnostics)) {
    return null;
  }

  const command = typeof executionRecord.command === "string" ? executionRecord.command : undefined;
  if (!command) {
    diagnostics.push(createDiagnostic("error", "execution-command-missing", "Execution.command is required."));
    return null;
  }

  const cwdValue = typeof executionRecord.cwd === "string" ? executionRecord.cwd : undefined;
  const args = Array.isArray(executionRecord.args)
    ? executionRecord.args.filter((entry): entry is string => typeof entry === "string")
    : [];
  const env = normalizeStringMap(executionRecord.env);
  const pluginPackage = readPluginPackage(executionRecord, resolvedModel);

  if (!pluginPackage) {
    diagnostics.push(
      createDiagnostic("error", "plugin-package-missing", "Execution.pluginPackage is required in v0.1.0."),
    );
  }

  return {
    pluginPackage,
    command,
    args,
    env,
    cwd: cwdValue ? path.resolve(repoRoot, cwdValue) : repoRoot,
    raw: executionRecord,
  };
}

function normalizeExecutionRecord(resolvedModel: Record<string, unknown>): Record<string, unknown> | null {
  const execution = resolvedModel.Execution;
  if (isRecord(execution)) {
    return { ...execution };
  }

  const runCommand = resolvedModel.RunCommand;
  if (typeof runCommand === "string") {
    return {
      command: runCommand,
      args: [],
      env: {},
    };
  }

  if (isRecord(runCommand)) {
    return {
      ...runCommand,
      command: typeof runCommand.command === "string" ? runCommand.command : runCommand.Command,
      args: Array.isArray(runCommand.args) ? runCommand.args : runCommand.Args,
      env: isRecord(runCommand.env) ? runCommand.env : runCommand.Env,
      cwd: typeof runCommand.cwd === "string" ? runCommand.cwd : runCommand.Cwd,
      pluginPackage:
        typeof runCommand.pluginPackage === "string" ? runCommand.pluginPackage : runCommand.PluginPackage,
    };
  }

  return null;
}

function readPluginPackage(
  executionRecord: Record<string, unknown>,
  resolvedModel: Record<string, unknown>,
): string | undefined {
  if (typeof executionRecord.pluginPackage === "string") {
    return executionRecord.pluginPackage;
  }

  if (typeof executionRecord.plugin === "string") {
    return executionRecord.plugin;
  }

  if (typeof resolvedModel.PluginPackage === "string") {
    return resolvedModel.PluginPackage;
  }

  return undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findLayerSource(repoModel: RepoModel, layerName: string): string {
  const directLayer = [...repoModel.layers].reverse().find((layer) => layerName in layer.envMapLayers);
  return directLayer?.sourcePath ?? repoModel.rootDirectory;
}
