"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRepoModel = buildRepoModel;
const diagnostics_1 = require("../diagnostics");
const BASE_FILE_NAME = "repo-base.default.envheaven.env-map-layer.json";
function buildRepoModel(discovery) {
    const diagnostics = [...discovery.diagnostics];
    const validFiles = discovery.files.filter((file) => file.payload !== null && !hasParseErrors(file));
    const baseFile = validFiles.find((file) => file.fileName === BASE_FILE_NAME);
    if (!baseFile) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "base-layer-missing", `Required base layer "${BASE_FILE_NAME}" was not found.`, discovery.rootDirectory));
    }
    const orderedFiles = validFiles.sort((left, right) => {
        if (left.fileName === BASE_FILE_NAME) {
            return -1;
        }
        if (right.fileName === BASE_FILE_NAME) {
            return 1;
        }
        return left.sourcePath.localeCompare(right.sourcePath);
    });
    const layers = orderedFiles.map(normalizeLayer);
    const envMapLayers = {};
    const artifacts = baseFile ? normalizeNamedRecords(baseFile.payload?.Artifacts) : {};
    const artifactsRunners = baseFile ? normalizeNamedRecords(baseFile.payload?.ArtifactsRunners) : {};
    const artifactsDistributors = baseFile ? normalizeNamedRecords(baseFile.payload?.ArtifactsDistributors) : {};
    const repoDeployExecutions = baseFile ? normalizeExecutionGroups(baseFile.payload?.RepoDeployExecutions) : {};
    const aliases = {};
    const fallbackList = [];
    for (const layer of layers) {
        for (const [layerName, value] of Object.entries(layer.envMapLayers)) {
            envMapLayers[layerName] = deepMergeObjects(envMapLayers[layerName] ?? {}, value);
        }
        for (const [alias, targets] of Object.entries(layer.aliases)) {
            aliases[alias] = [...targets];
        }
        for (const fallbackTarget of layer.fallbackList) {
            if (!fallbackList.includes(fallbackTarget)) {
                fallbackList.push(fallbackTarget);
            }
        }
    }
    for (const optionalLayerName of fallbackList) {
        if (!(optionalLayerName in envMapLayers)) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("info", "optional-layer-missing", `Optional fallback layer "${optionalLayerName}" is not present.`, discovery.rootDirectory));
        }
    }
    return {
        rootDirectory: discovery.rootDirectory,
        layers,
        envMapLayers,
        artifacts,
        artifactsRunners,
        artifactsDistributors,
        repoDeployExecutions,
        aliases,
        fallbackList,
        diagnostics,
        discovery,
    };
}
function normalizeNamedRecords(value) {
    if (!isRecord(value)) {
        return {};
    }
    const result = {};
    for (const [key, entryValue] of Object.entries(value)) {
        if (isRecord(entryValue)) {
            result[key] = deepCloneRecord(entryValue);
        }
    }
    return result;
}
function normalizeExecutionGroups(value) {
    if (!isRecord(value)) {
        return {};
    }
    const result = {};
    for (const [key, entryValue] of Object.entries(value)) {
        if (!Array.isArray(entryValue)) {
            continue;
        }
        result[key] = entryValue.filter((item) => isRecord(item)).map(deepCloneRecord);
    }
    return result;
}
function normalizeLayer(file) {
    const payload = file.payload ?? {};
    return {
        sourcePath: file.sourcePath,
        fileName: file.fileName,
        envMapLayers: normalizeEnvMapLayers(payload.EnvMapLayers),
        aliases: normalizeAliases(payload.aliases ?? payload.Aliases),
        fallbackList: normalizeStringArray(payload["fallback-list"] ?? payload.fallbackList ?? payload.FallbackList),
    };
}
function normalizeEnvMapLayers(value) {
    if (!isRecord(value)) {
        return {};
    }
    const result = {};
    for (const [key, entryValue] of Object.entries(value)) {
        if (isRecord(entryValue)) {
            result[key] = deepCloneRecord(entryValue);
        }
    }
    return result;
}
function normalizeAliases(value) {
    if (!isRecord(value)) {
        return {};
    }
    const aliases = {};
    for (const [alias, targetValue] of Object.entries(value)) {
        if (typeof targetValue === "string") {
            aliases[alias] = [targetValue];
            continue;
        }
        if (Array.isArray(targetValue)) {
            aliases[alias] = targetValue.filter((item) => typeof item === "string");
        }
    }
    return aliases;
}
function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => typeof item === "string");
}
function deepCloneRecord(value) {
    return JSON.parse(JSON.stringify(value));
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
            result[key] = [...value];
            continue;
        }
        result[key] = value;
    }
    return result;
}
function hasParseErrors(file) {
    return file.diagnostics.some((diagnostic) => diagnostic.code === "jsonc-parse-error");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
