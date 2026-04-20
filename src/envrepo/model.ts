import { createDiagnostic } from "../diagnostics";
import type { Diagnostic, EnvRepoFile, NormalizedLayer, RepoDiscoveryResult, RepoModel } from "../types";

const BASE_FILE_NAME = "repo-base.default.envheaven.env-map-layer.json";

export function buildRepoModel(discovery: RepoDiscoveryResult): RepoModel {
  const diagnostics: Diagnostic[] = [...discovery.diagnostics];
  const validFiles = discovery.files.filter((file) => file.payload !== null && !hasParseErrors(file));
  const baseFile = validFiles.find((file) => file.fileName === BASE_FILE_NAME);

  if (!baseFile) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "base-layer-missing",
        `Required base layer "${BASE_FILE_NAME}" was not found.`,
        discovery.rootDirectory,
      ),
    );
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
  const envMapLayers: RepoModel["envMapLayers"] = {};
  const artifacts = baseFile ? normalizeNamedRecords(baseFile.payload?.Artifacts) : {};
  const artifactsRunners = baseFile ? normalizeNamedRecords(baseFile.payload?.ArtifactsRunners) : {};
  const artifactsDistributors = baseFile ? normalizeNamedRecords(baseFile.payload?.ArtifactsDistributors) : {};
  const repoDeployExecutions = baseFile ? normalizeExecutionGroups(baseFile.payload?.RepoDeployExecutions) : {};
  const aliases: RepoModel["aliases"] = {};
  const fallbackList: string[] = [];

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
      diagnostics.push(
        createDiagnostic(
          "info",
          "optional-layer-missing",
          `Optional fallback layer "${optionalLayerName}" is not present.`,
          discovery.rootDirectory,
        ),
      );
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

function normalizeNamedRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (isRecord(entryValue)) {
      result[key] = deepCloneRecord(entryValue);
    }
  }

  return result;
}

function normalizeExecutionGroups(value: unknown): Record<string, Record<string, unknown>[]> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, Record<string, unknown>[]> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (!Array.isArray(entryValue)) {
      continue;
    }

    result[key] = entryValue.filter((item): item is Record<string, unknown> => isRecord(item)).map(deepCloneRecord);
  }

  return result;
}

function normalizeLayer(file: EnvRepoFile): NormalizedLayer {
  const payload = file.payload ?? {};
  const sharedLayerSections = normalizeSharedLayerSections(payload);
  const envMapLayers = normalizeEnvMapLayers(payload.EnvMapLayers);

  for (const [layerName, layerValue] of Object.entries(envMapLayers)) {
    envMapLayers[layerName] = deepMergeObjects(layerValue, sharedLayerSections);
  }

  return {
    sourcePath: file.sourcePath,
    fileName: file.fileName,
    envMapLayers,
    aliases: normalizeAliases(payload.aliases ?? payload.Aliases),
    fallbackList: normalizeStringArray(payload["fallback-list"] ?? payload.fallbackList ?? payload.FallbackList),
  };
}

function normalizeSharedLayerSections(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (isRecord(payload.ArtifactsRunners)) {
    result.ArtifactsRunners = deepCloneRecord(payload.ArtifactsRunners);
  }

  if (isRecord(payload.ArtifactsDistributors)) {
    result.ArtifactsDistributors = deepCloneRecord(payload.ArtifactsDistributors);
  }

  if (isRecord(payload.RepoDeployExecutions)) {
    result.RepoDeployExecutions = deepCloneRecord(payload.RepoDeployExecutions);
  }

  return result;
}

function normalizeEnvMapLayers(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (isRecord(entryValue)) {
      result[key] = deepCloneRecord(entryValue);
    }
  }

  return result;
}

function normalizeAliases(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  const aliases: Record<string, string[]> = {};
  for (const [alias, targetValue] of Object.entries(value)) {
    if (typeof targetValue === "string") {
      aliases[alias] = [targetValue];
      continue;
    }

    if (Array.isArray(targetValue)) {
      aliases[alias] = targetValue.filter((item): item is string => typeof item === "string");
    }
  }
  return aliases;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function deepCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
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
      result[key] = [...value];
      continue;
    }

    result[key] = value;
  }

  return result;
}

function hasParseErrors(file: EnvRepoFile): boolean {
  return file.diagnostics.some((diagnostic) => diagnostic.code === "jsonc-parse-error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
