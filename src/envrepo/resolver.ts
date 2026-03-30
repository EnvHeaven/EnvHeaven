import path from "node:path";
import { createDiagnostic, hasErrors } from "../diagnostics";
import type {
  ArtifactExecutionPlan,
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
  const artifactExecutions = materializeArtifactExecutions(
    repoModel,
    resolvedModel,
    targetResolution.resolvedTarget,
    diagnostics,
  );
  const execution = artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ?? null;
  const pluginPackage = execution?.pluginPackage;

  if (!execution && artifactExecutions.length === 0) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "execution-missing",
        "No ArtifactsRunners were available to materialize runnable artifact executions.",
      ),
    );
  } else if (!execution) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "execution-missing",
        "No runnable artifact executions remained after materialization.",
      ),
    );
  }

  return {
    requestedTarget: target,
    resolvedTarget: targetResolution.resolvedTarget,
    targetResolutionTrace: targetResolution.trace,
    mergeOrder,
    diagnostics,
    trace,
    artifactExecutions,
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

function normalizeExecutionRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  const execution = value.Execution;
  if (isRecord(execution)) {
    return { ...execution };
  }

  const runCommand = value.RunCommand;
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
  value: Record<string, unknown>,
): string | undefined {
  if (typeof executionRecord.pluginPackage === "string") {
    return executionRecord.pluginPackage;
  }

  if (typeof executionRecord.plugin === "string") {
    return executionRecord.plugin;
  }

  if (typeof value.PluginPackage === "string") {
    return value.PluginPackage;
  }

  return undefined;
}

function materializeArtifactExecutions(
  repoModel: RepoModel,
  resolvedModel: Record<string, unknown>,
  resolvedTarget: string,
  diagnostics: Diagnostic[],
): ArtifactExecutionPlan[] {
  const resolvedArtifacts = normalizeNamedRecords(resolvedModel.Artifacts);
  const artifactExecutions: ArtifactExecutionPlan[] = [];
  const blockedByPlanErrors = hasErrors(diagnostics);

  for (const [runnerName, runnerValue] of Object.entries(repoModel.artifactsRunners)) {
    const artifactDiagnostics: Diagnostic[] = [];
    const materializationTrace = [`runner:${runnerName}`];
    const artifactName = readArtifactName(runnerValue);

    if (!artifactName) {
      artifactDiagnostics.push(
        createDiagnostic("warning", "artifact-runner-artifact-missing", `Runner "${runnerName}" does not declare ArtifactName.`),
      );
      artifactExecutions.push({
        artifactName: "",
        runnerName,
        status: "partial",
        diagnostics: artifactDiagnostics,
        trace: materializationTrace,
        execution: null,
      });
      continue;
    }

    materializationTrace.push(`artifact:${artifactName}`);
    const baseArtifact = repoModel.artifacts[artifactName];
    if (!baseArtifact) {
      artifactDiagnostics.push(
        createDiagnostic(
          "warning",
          "artifact-missing",
          `Artifact "${artifactName}" referenced by runner "${runnerName}" was not found in repo-base Artifacts.`,
        ),
      );
      artifactExecutions.push({
        artifactName,
        runnerName,
        status: "partial",
        diagnostics: artifactDiagnostics,
        trace: materializationTrace,
        execution: null,
      });
      continue;
    }

    const finalArtifact = deepMergeObjects(baseArtifact, resolvedArtifacts[artifactName] ?? {});
    const templateContext = buildTemplateContext(finalArtifact, resolvedTarget, repoModel.rootDirectory);
    const executionRecord = normalizeExecutionRecord(runnerValue);

    if (!executionRecord) {
      artifactDiagnostics.push(
        createDiagnostic(
          "warning",
          "artifact-runner-execution-missing",
          `Runner "${runnerName}" does not expose Execution or RunCommand.`,
        ),
      );
      artifactExecutions.push({
        artifactName,
        runnerName,
        status: "partial",
        diagnostics: artifactDiagnostics,
        trace: materializationTrace,
        execution: null,
      });
      continue;
    }

    const materializedExecution = materializeExecutionRecord(
      runnerName,
      artifactName,
      executionRecord,
      runnerValue,
      repoModel.rootDirectory,
      templateContext,
      blockedByPlanErrors,
      artifactDiagnostics,
      materializationTrace,
    );

    artifactExecutions.push({
      artifactName,
      runnerName,
      status: materializedExecution ? "runnable" : "partial",
      diagnostics: artifactDiagnostics,
      trace: materializationTrace,
      execution: materializedExecution,
    });
  }

  diagnostics.push(...artifactExecutions.flatMap((artifactExecution) => artifactExecution.diagnostics));
  return artifactExecutions;
}

function materializeExecutionRecord(
  runnerName: string,
  artifactName: string,
  executionRecord: Record<string, unknown>,
  runnerValue: Record<string, unknown>,
  repoRoot: string,
  templateContext: TemplateContext,
  blockedByPlanErrors: boolean,
  diagnostics: Diagnostic[],
  trace: string[],
): ExecutionSpec | null {
  if (blockedByPlanErrors || hasErrors(diagnostics)) {
    return null;
  }

  const command = materializeTemplateString(executionRecord.command, artifactName, templateContext, diagnostics, "command");
  if (!command) {
    diagnostics.push(
      createDiagnostic("warning", "execution-command-missing", `Runner "${runnerName}" is missing Execution.command.`),
    );
    return null;
  }

  const args = materializeStringArray(executionRecord.args, artifactName, templateContext, diagnostics, "args");
  const env = materializeStringMap(executionRecord.env, artifactName, templateContext, diagnostics, "env");
  const cwdValue = materializeTemplateString(executionRecord.cwd, artifactName, templateContext, diagnostics, "cwd");
  const pluginPackage = materializeTemplateString(
    readPluginPackage(executionRecord, runnerValue),
    artifactName,
    templateContext,
    diagnostics,
    "pluginPackage",
  );

  if (!pluginPackage) {
    diagnostics.push(
      createDiagnostic(
        "warning",
        "plugin-package-missing",
        `Runner "${runnerName}" is missing Execution.pluginPackage.`,
      ),
    );
    return null;
  }

  trace.push(`command:${command}`);
  return {
    pluginPackage,
    command,
    args,
    env,
    cwd: cwdValue ? path.resolve(repoRoot, cwdValue) : repoRoot,
    raw: executionRecord,
  };
}

interface TemplateContext {
  repoCloneFolderPath?: string;
  port?: string;
  envMapName: string;
  envVarsJson: string;
}

function buildTemplateContext(
  finalArtifact: Record<string, unknown>,
  resolvedTarget: string,
  repoRoot: string,
): TemplateContext {
  const rawRepoCloneFolderPath = readStringValue(finalArtifact, ["RepoCloneFolderPath", "repoCloneFolderPath"]);
  const repoCloneFolderPath = rawRepoCloneFolderPath ? path.resolve(repoRoot, rawRepoCloneFolderPath) : undefined;
  const port = readPortValue(finalArtifact);
  const envMapName =
    readStringValue(finalArtifact, ["EnvMapName", "envMapName"]) ??
    resolvedTarget;
  const envVars = normalizeStringMap(finalArtifact.EnvVars ?? finalArtifact.envVars);

  return {
    repoCloneFolderPath,
    port,
    envMapName,
    envVarsJson: JSON.stringify(envVars),
  };
}

function materializeTemplateString(
  value: unknown,
  artifactName: string,
  templateContext: TemplateContext,
  diagnostics: Diagnostic[],
  fieldName: string,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const replaced = value.replace(/\{\{\s*(GetFinalRepoCloneFolderPathOf|GetFinalPortOf|GetFinalEnvMapNameOf|GetFinalEnvVarsAsJson)\('([^']+)'\)\s*\}\}/g, (_match, templateName: string, templateArtifactName: string) => {
    if (templateArtifactName !== artifactName) {
      diagnostics.push(
        createDiagnostic(
          "warning",
          "artifact-template-mismatch",
          `Template references artifact "${templateArtifactName}" but runner is bound to "${artifactName}".`,
        ),
      );
      return "";
    }

    switch (templateName) {
      case "GetFinalRepoCloneFolderPathOf":
        return templateContext.repoCloneFolderPath ?? "";
      case "GetFinalPortOf":
        return templateContext.port ?? "";
      case "GetFinalEnvMapNameOf":
        return templateContext.envMapName;
      case "GetFinalEnvVarsAsJson":
        return templateContext.envVarsJson;
      default:
        return "";
    }
  });

  if (replaced.includes("{{") || replaced === "") {
    if (value.includes("{{")) {
      diagnostics.push(
        createDiagnostic(
          "warning",
          "artifact-template-unresolved",
          `Unable to resolve ${fieldName} template for artifact "${artifactName}".`,
        ),
      );
    }
  }

  return replaced.length > 0 ? replaced : undefined;
}

function materializeStringArray(
  value: unknown,
  artifactName: string,
  templateContext: TemplateContext,
  diagnostics: Diagnostic[],
  fieldName: string,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => materializeTemplateString(entry, artifactName, templateContext, diagnostics, fieldName))
    .filter((entry): entry is string => typeof entry === "string");
}

function materializeStringMap(
  value: unknown,
  artifactName: string,
  templateContext: TemplateContext,
  diagnostics: Diagnostic[],
  fieldName: string,
): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const materializedValue = materializeTemplateString(entry, artifactName, templateContext, diagnostics, `${fieldName}.${key}`);
    if (materializedValue !== undefined) {
      result[key] = materializedValue;
    }
  }
  return result;
}

function readArtifactName(value: Record<string, unknown>): string | undefined {
  return readStringValue(value, ["ArtifactName", "artifactName"]);
}

function readStringValue(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") {
      return value[key] as string;
    }
  }

  return undefined;
}

function readPortValue(value: Record<string, unknown>): string | undefined {
  const rawValue = value.Port ?? value.port;
  if (typeof rawValue === "number" || typeof rawValue === "string") {
    return String(rawValue);
  }

  return undefined;
}

function normalizeNamedRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (isRecord(entryValue)) {
      result[key] = deepClone(entryValue);
    }
  }
  return result;
}

function deepMergeObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = result[key];
    if (isRecord(previous) && isRecord(value)) {
      result[key] = deepMergeObjects(previous, value);
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = value.map((entry) => deepClone(entry));
      continue;
    }

    result[key] = deepClone(value);
  }

  return result;
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
