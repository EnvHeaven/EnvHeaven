"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePlan = resolvePlan;
const node_path_1 = __importDefault(require("node:path"));
const diagnostics_1 = require("../diagnostics");
const ALLOWED_CONDITION_TYPES = new Set(["always-force", "only-if-full-setup-completion"]);
function resolvePlan(repoModel, target, kind = "run") {
    const diagnostics = [...repoModel.diagnostics];
    const trace = [];
    const initialTarget = resolveAlias(repoModel, target, diagnostics);
    const targetResolution = resolveConcreteTarget(repoModel, initialTarget, diagnostics);
    const mergeOrder = buildMergeOrder(repoModel, targetResolution.resolvedTarget, diagnostics);
    const resolvedModel = {};
    for (const layerName of mergeOrder) {
        const layerValue = repoModel.envMapLayers[layerName];
        if (!layerValue) {
            continue;
        }
        const source = findLayerSource(repoModel, layerName);
        mergeIntoResolvedModel(resolvedModel, layerValue, source, layerName, trace, "");
    }
    validateConditionTypes(resolvedModel, diagnostics, []);
    const isDeployStyleRunTarget = kind === "run" &&
        (target === "install-revert" ||
            target === "install-revert-01" ||
            targetResolution.resolvedTarget === "install-revert-01");
    const repoExecutions = kind === "deploy" || isDeployStyleRunTarget
        ? materializeRepoDeployExecutions(repoModel, targetResolution.resolvedTarget, diagnostics)
        : [];
    const artifactExecutions = kind === "deploy"
        ? materializeArtifactDistributors(repoModel, resolvedModel, targetResolution.resolvedTarget, diagnostics)
        : isDeployStyleRunTarget
            ? []
            : materializeArtifactExecutions(repoModel, resolvedModel, targetResolution.resolvedTarget, diagnostics);
    const execution = repoExecutions.find((repoExecution) => repoExecution.status === "runnable")?.execution ??
        artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ??
        null;
    const pluginPackage = execution?.pluginPackage;
    if (!execution && repoExecutions.length === 0 && artifactExecutions.length === 0) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "execution-missing", kind === "deploy"
            ? "No deploy executions were available to materialize."
            : "No ArtifactsRunners were available to materialize runnable artifact executions."));
    }
    else if (!execution) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "execution-missing", kind === "deploy"
            ? "No runnable deploy executions remained after materialization."
            : "No runnable artifact executions remained after materialization."));
    }
    const deployGuard = extractDeployGuardConfig(resolvedModel);
    return {
        kind,
        requestedTarget: target,
        resolvedTarget: targetResolution.resolvedTarget,
        targetResolutionTrace: targetResolution.trace,
        mergeOrder,
        selectedArtifacts: [],
        diagnostics,
        trace,
        repoExecutions,
        artifactExecutions,
        execution,
        pluginPackage,
        resolvedModel,
        deployGuard,
    };
}
function resolveConcreteTarget(repoModel, target, diagnostics) {
    const seen = new Set();
    const trace = [target];
    let current = target;
    while (true) {
        if (seen.has(current)) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "target-cycle", `TargetName cycle detected at "${current}".`));
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
function resolveAlias(repoModel, target, diagnostics) {
    const seen = new Set();
    let current = target;
    while (repoModel.aliases[current]?.length) {
        if (seen.has(current)) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "alias-cycle", `Alias cycle detected at "${current}".`));
            break;
        }
        seen.add(current);
        current = repoModel.aliases[current][0];
    }
    return current;
}
function buildMergeOrder(repoModel, target, diagnostics) {
    const appliedOrder = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (layerName) => {
        const canonicalName = resolveConcreteTarget(repoModel, resolveAlias(repoModel, layerName, diagnostics), diagnostics).resolvedTarget;
        if (visited.has(canonicalName)) {
            return;
        }
        if (visiting.has(canonicalName)) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "fallback-cycle", `Fallback cycle detected at "${canonicalName}".`));
            return;
        }
        const layerValue = repoModel.envMapLayers[canonicalName];
        if (!layerValue) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)(canonicalName === target ? "error" : "warning", "missing-layer", `Resolved layer "${canonicalName}" is not present in EnvMapLayers.`));
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
function getFallbackList(repoModel, layerName, layerValue) {
    const nestedFallbacks = normalizeStringArray(layerValue["fallback-list"] ?? layerValue.fallbackList);
    if (layerName === "default") {
        return [...repoModel.fallbackList, ...nestedFallbacks];
    }
    return nestedFallbacks;
}
function mergeIntoResolvedModel(target, source, layerSource, layerName, trace, prefix) {
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
function validateConditionTypes(value, diagnostics, pathParts) {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => validateConditionTypes(entry, diagnostics, [...pathParts, String(index)]));
        return;
    }
    if (!isRecord(value)) {
        return;
    }
    const currentPath = pathParts.join(".");
    if (typeof value.Type === "string" &&
        pathParts.some((part) => part === "Condition" || part === "Conditions")) {
        if (!ALLOWED_CONDITION_TYPES.has(value.Type)) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "unsupported-condition-type", `Unsupported Condition.Type "${value.Type}".`, currentPath || undefined));
        }
    }
    for (const [key, nestedValue] of Object.entries(value)) {
        validateConditionTypes(nestedValue, diagnostics, [...pathParts, key]);
    }
}
function normalizeExecutionRecord(value) {
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
            pluginPackage: typeof runCommand.pluginPackage === "string" ? runCommand.pluginPackage : runCommand.PluginPackage,
        };
    }
    return null;
}
function readPluginPackage(executionRecord, value) {
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
function materializeArtifactExecutions(repoModel, resolvedModel, resolvedTarget, diagnostics) {
    const resolvedArtifacts = normalizeNamedRecords(resolvedModel.Artifacts);
    const finalArtifacts = Object.fromEntries(Object.entries(repoModel.artifacts).map(([artifactName, baseArtifact]) => [
        artifactName,
        deepMergeObjects(baseArtifact, resolvedArtifacts[artifactName] ?? {}),
    ]));
    const baseTemplateContexts = Object.fromEntries(Object.entries(finalArtifacts).map(([artifactName, finalArtifact]) => [
        artifactName,
        buildBaseTemplateContext(finalArtifact, resolvedTarget, repoModel.rootDirectory),
    ]));
    for (const [alias, targets] of Object.entries(repoModel.aliases)) {
        const targetArtifactName = targets[0];
        if (targetArtifactName && baseTemplateContexts[targetArtifactName]) {
            baseTemplateContexts[alias] = baseTemplateContexts[targetArtifactName];
        }
    }
    const artifactExecutions = [];
    const blockedByPlanErrors = (0, diagnostics_1.hasErrors)(diagnostics);
    for (const [runnerName, runnerValue] of Object.entries(repoModel.artifactsRunners)) {
        const artifactDiagnostics = [];
        const materializationTrace = [`runner:${runnerName}`];
        const artifactName = readArtifactName(runnerValue);
        if (!artifactName) {
            artifactDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-runner-artifact-missing", `Runner "${runnerName}" does not declare ArtifactName.`));
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
            artifactDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-missing", `Artifact "${artifactName}" referenced by runner "${runnerName}" was not found in repo-base Artifacts.`));
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
        const finalArtifact = finalArtifacts[artifactName] ?? deepMergeObjects(baseArtifact, resolvedArtifacts[artifactName] ?? {});
        const templateContext = buildTemplateContext(artifactName, finalArtifact, resolvedTarget, repoModel.rootDirectory, baseTemplateContexts);
        const executionRecord = normalizeExecutionRecord(runnerValue);
        if (!executionRecord) {
            artifactDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-runner-execution-missing", `Runner "${runnerName}" does not expose Execution or RunCommand.`));
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
        const materializedExecution = materializeExecutionRecord(runnerName, artifactName, executionRecord, runnerValue, repoModel.rootDirectory, templateContext, false, blockedByPlanErrors, artifactDiagnostics, materializationTrace);
        if (materializedExecution) {
            const layerEnvVars = materializeArtifactEnvVars(normalizeStringMap(finalArtifact.EnvVars ?? finalArtifact.envVars), baseTemplateContexts);
            if (Object.keys(layerEnvVars).length > 0) {
                materializedExecution.env = { ...layerEnvVars, ...materializedExecution.env };
            }
        }
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
function materializeRepoDeployExecutions(repoModel, resolvedTarget, diagnostics) {
    const blockedByPlanErrors = (0, diagnostics_1.hasErrors)(diagnostics);
    const steps = repoModel.repoDeployExecutions[resolvedTarget] ?? [];
    const repoExecutions = steps.map((step, index) => {
        const stepDiagnostics = [];
        const name = typeof step.Name === "string" ? step.Name : `repo-step-${String(index + 1)}`;
        const executionRecord = normalizeExecutionRecord(step);
        if (!executionRecord) {
            stepDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "repo-deploy-execution-missing", `Deploy step "${name}" has no Execution or RunCommand.`));
            return {
                name,
                status: "partial",
                diagnostics: stepDiagnostics,
                trace: [`repo-step:${name}`],
                execution: null,
            };
        }
        const execution = materializeExecutionRecord(name, "__repo__", executionRecord, step, repoModel.rootDirectory, {
            envMapName: resolvedTarget,
            envVarsJson: "{}",
        }, false, blockedByPlanErrors, stepDiagnostics, [`repo-step:${name}`]);
        const status = execution ? "runnable" : "partial";
        return {
            name,
            status,
            diagnostics: stepDiagnostics,
            trace: [`repo-step:${name}`],
            execution,
        };
    });
    diagnostics.push(...repoExecutions.flatMap((repoExecution) => repoExecution.diagnostics));
    return repoExecutions;
}
function materializeArtifactDistributors(repoModel, resolvedModel, resolvedTarget, diagnostics) {
    const resolvedArtifacts = normalizeNamedRecords(resolvedModel.Artifacts);
    const finalArtifacts = Object.fromEntries(Object.entries(repoModel.artifacts).map(([artifactName, baseArtifact]) => [
        artifactName,
        deepMergeObjects(baseArtifact, resolvedArtifacts[artifactName] ?? {}),
    ]));
    const baseTemplateContexts = Object.fromEntries(Object.entries(finalArtifacts).map(([artifactName, finalArtifact]) => [
        artifactName,
        buildBaseTemplateContext(finalArtifact, resolvedTarget, repoModel.rootDirectory),
    ]));
    for (const [alias, targets] of Object.entries(repoModel.aliases)) {
        const targetArtifactName = targets[0];
        if (targetArtifactName && baseTemplateContexts[targetArtifactName]) {
            baseTemplateContexts[alias] = baseTemplateContexts[targetArtifactName];
        }
    }
    const blockedByPlanErrors = (0, diagnostics_1.hasErrors)(diagnostics);
    const distributors = Object.entries(repoModel.artifactsDistributors)
        .filter(([, distributorValue]) => readStringValue(distributorValue, ["DeployTarget", "deployTarget"]) === resolvedTarget)
        .sort((left, right) => {
        const leftOrder = readNumericValue(left[1], ["Order", "order"]) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = readNumericValue(right[1], ["Order", "order"]) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left[0].localeCompare(right[0]);
    });
    const artifactExecutions = distributors.map(([distributorName, distributorValue]) => {
        const artifactDiagnostics = [];
        const artifactName = readArtifactName(distributorValue) ?? "";
        const trace = [`distributor:${distributorName}`, `artifact:${artifactName}`];
        if (!artifactName) {
            artifactDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-distributor-artifact-missing", `Distributor "${distributorName}" does not declare ArtifactName.`));
            return {
                artifactName,
                runnerName: distributorName,
                status: "partial",
                diagnostics: artifactDiagnostics,
                trace,
                execution: null,
            };
        }
        const baseArtifact = repoModel.artifacts[artifactName];
        if (!baseArtifact) {
            artifactDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-missing", `Artifact "${artifactName}" referenced by distributor "${distributorName}" was not found in repo-base Artifacts.`));
            return {
                artifactName,
                runnerName: distributorName,
                status: "partial",
                diagnostics: artifactDiagnostics,
                trace,
                execution: null,
            };
        }
        if (readBooleanValue(baseArtifact, ["Private", "private"]) === true && resolvedTarget === "production-01") {
            artifactDiagnostics.push((0, diagnostics_1.createDiagnostic)("info", "artifact-private-skip", `Skipping private artifact "${artifactName}" for production publish.`));
            return {
                artifactName,
                runnerName: distributorName,
                status: "partial",
                diagnostics: artifactDiagnostics,
                trace,
                execution: null,
            };
        }
        const finalArtifact = finalArtifacts[artifactName] ?? deepMergeObjects(baseArtifact, resolvedArtifacts[artifactName] ?? {});
        const executionRecord = normalizeExecutionRecord(distributorValue);
        if (!executionRecord) {
            artifactDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-distributor-execution-missing", `Distributor "${distributorName}" has no Execution or RunCommand.`));
            return {
                artifactName,
                runnerName: distributorName,
                status: "partial",
                diagnostics: artifactDiagnostics,
                trace,
                execution: null,
            };
        }
        const execution = materializeExecutionRecord(distributorName, artifactName, executionRecord, distributorValue, repoModel.rootDirectory, buildTemplateContext(artifactName, finalArtifact, resolvedTarget, repoModel.rootDirectory, baseTemplateContexts), false, blockedByPlanErrors, artifactDiagnostics, trace);
        if (execution) {
            const layerEnvVars = materializeArtifactEnvVars(normalizeStringMap(finalArtifact.EnvVars ?? finalArtifact.envVars), baseTemplateContexts);
            if (Object.keys(layerEnvVars).length > 0) {
                execution.env = { ...layerEnvVars, ...execution.env };
            }
        }
        const status = execution ? "runnable" : "partial";
        return {
            artifactName,
            packageName: readStringValue(baseArtifact, ["PackageName", "packageName"]),
            repoCloneFolderPath: readStringValue(baseArtifact, ["RepoCloneFolderPath", "repoCloneFolderPath"]),
            deployTarget: resolvedTarget,
            runnerName: distributorName,
            status,
            diagnostics: artifactDiagnostics,
            trace,
            execution,
        };
    });
    diagnostics.push(...artifactExecutions.flatMap((artifactExecution) => artifactExecution.diagnostics));
    return artifactExecutions;
}
function materializeExecutionRecord(runnerName, artifactName, executionRecord, runnerValue, repoRoot, templateContext, requirePluginPackage, blockedByPlanErrors, diagnostics, trace) {
    if (blockedByPlanErrors || (0, diagnostics_1.hasErrors)(diagnostics)) {
        return null;
    }
    const command = materializeTemplateString(executionRecord.command, artifactName, templateContext, diagnostics, "command");
    if (!command) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "execution-command-missing", `Runner "${runnerName}" is missing Execution.command.`));
        return null;
    }
    const args = materializeStringArray(executionRecord.args, artifactName, templateContext, diagnostics, "args");
    const env = materializeStringMap(executionRecord.env, artifactName, templateContext, diagnostics, "env");
    const cwdValue = materializeTemplateString(executionRecord.cwd, artifactName, templateContext, diagnostics, "cwd");
    const pluginPackage = materializeTemplateString(readPluginPackage(executionRecord, runnerValue), artifactName, templateContext, diagnostics, "pluginPackage");
    if (requirePluginPackage && !pluginPackage) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "plugin-package-missing", `Runner "${runnerName}" is missing Execution.pluginPackage.`));
        return null;
    }
    trace.push(`command:${command}`);
    return {
        pluginPackage,
        command,
        args,
        env,
        cwd: cwdValue ? node_path_1.default.resolve(repoRoot, cwdValue) : repoRoot,
        raw: executionRecord,
    };
}
function buildBaseTemplateContext(finalArtifact, resolvedTarget, repoRoot) {
    const rawRepoCloneFolderPath = readStringValue(finalArtifact, ["RepoCloneFolderPath", "repoCloneFolderPath"]);
    const repoCloneFolderPath = rawRepoCloneFolderPath ? node_path_1.default.resolve(repoRoot, rawRepoCloneFolderPath) : undefined;
    const port = readPortValue(finalArtifact);
    const envMapName = readStringValue(finalArtifact, ["EnvMapName", "envMapName"]) ??
        resolvedTarget;
    return {
        repoCloneFolderPath,
        port,
        envMapName,
    };
}
function materializeArtifactEnvVars(envVars, baseTemplateContexts) {
    const finalValuePattern = /\{\{\s*(GetFinalRepoCloneFolderPathOf|GetFinalPortOf|GetFinalEnvMapNameOf)\((['"`])([^'"`]+)\2\)\s*\}\}/g;
    return Object.fromEntries(Object.entries(envVars).map(([key, value]) => [
        key,
        value.replace(finalValuePattern, (_match, templateName, _quote, templateArtifactName) => {
            const templateContext = baseTemplateContexts[templateArtifactName];
            if (!templateContext) {
                return "";
            }
            switch (templateName) {
                case "GetFinalRepoCloneFolderPathOf":
                    return templateContext.repoCloneFolderPath ?? "";
                case "GetFinalPortOf":
                    return templateContext.port ?? "";
                case "GetFinalEnvMapNameOf":
                    return templateContext.envMapName;
                default:
                    return "";
            }
        }),
    ]));
}
function buildTemplateContext(_artifactName, finalArtifact, resolvedTarget, repoRoot, baseTemplateContexts) {
    const baseTemplateContext = buildBaseTemplateContext(finalArtifact, resolvedTarget, repoRoot);
    const envVars = materializeArtifactEnvVars(normalizeStringMap(finalArtifact.EnvVars ?? finalArtifact.envVars), baseTemplateContexts);
    return {
        repoCloneFolderPath: baseTemplateContext.repoCloneFolderPath,
        port: baseTemplateContext.port,
        envMapName: baseTemplateContext.envMapName,
        envVarsJson: JSON.stringify(envVars),
    };
}
function materializeTemplateString(value, artifactName, templateContext, diagnostics, fieldName) {
    if (typeof value !== "string") {
        return undefined;
    }
    const replaced = value.replace(/\{\{\s*(GetFinalRepoCloneFolderPathOf|GetFinalPortOf|GetFinalEnvMapNameOf|GetFinalEnvVarsAsJson)\((['"`])([^'"`]+)\2\)\s*\}\}/g, (_match, templateName, _quote, templateArtifactName) => {
        if (templateArtifactName !== artifactName) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-template-mismatch", `Template references artifact "${templateArtifactName}" but runner is bound to "${artifactName}".`));
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
            diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-template-unresolved", `Unable to resolve ${fieldName} template for artifact "${artifactName}".`));
        }
    }
    return replaced.length > 0 ? replaced : undefined;
}
function materializeStringArray(value, artifactName, templateContext, diagnostics, fieldName) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => materializeTemplateString(entry, artifactName, templateContext, diagnostics, fieldName))
        .filter((entry) => typeof entry === "string");
}
function materializeStringMap(value, artifactName, templateContext, diagnostics, fieldName) {
    if (!isRecord(value)) {
        return {};
    }
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        const materializedValue = materializeTemplateString(entry, artifactName, templateContext, diagnostics, `${fieldName}.${key}`);
        if (materializedValue !== undefined) {
            result[key] = materializedValue;
        }
    }
    return result;
}
function readArtifactName(value) {
    return readStringValue(value, ["ArtifactName", "artifactName"]);
}
function readStringValue(value, keys) {
    for (const key of keys) {
        if (typeof value[key] === "string") {
            return value[key];
        }
    }
    return undefined;
}
function readNumericValue(value, keys) {
    for (const key of keys) {
        if (typeof value[key] === "number") {
            return value[key];
        }
    }
    return undefined;
}
function readBooleanValue(value, keys) {
    for (const key of keys) {
        if (typeof value[key] === "boolean") {
            return value[key];
        }
    }
    return undefined;
}
function readPortValue(value) {
    const rawValue = value.Port ?? value.port;
    if (typeof rawValue === "number" || typeof rawValue === "string") {
        return String(rawValue);
    }
    return undefined;
}
function normalizeNamedRecords(value) {
    if (!isRecord(value)) {
        return {};
    }
    const result = {};
    for (const [key, entryValue] of Object.entries(value)) {
        if (isRecord(entryValue)) {
            result[key] = deepClone(entryValue);
        }
    }
    return result;
}
function deepMergeObjects(base, override) {
    const result = { ...base };
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
function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === "string");
}
function normalizeStringMap(value) {
    if (!isRecord(value)) {
        return {};
    }
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") {
            result[key] = entry;
        }
    }
    return result;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}
function findLayerSource(repoModel, layerName) {
    const directLayer = [...repoModel.layers].reverse().find((layer) => layerName in layer.envMapLayers);
    return directLayer?.sourcePath ?? repoModel.rootDirectory;
}
function extractDeployGuardConfig(resolvedModel) {
    const guard = resolvedModel["DeployGuard"] ?? resolvedModel["deployGuard"];
    if (guard === true) {
        return { requireChallenge: true };
    }
    if (isRecord(guard)) {
        const requireChallenge = typeof guard["requireChallenge"] === "boolean"
            ? guard["requireChallenge"]
            : typeof guard["RequireChallenge"] === "boolean"
                ? guard["RequireChallenge"]
                : false;
        const reason = typeof guard["reason"] === "string"
            ? guard["reason"]
            : typeof guard["Reason"] === "string"
                ? guard["Reason"]
                : undefined;
        return { requireChallenge, reason };
    }
    return undefined;
}
