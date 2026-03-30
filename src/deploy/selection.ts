import { createDiagnostic } from "../diagnostics";
import type { ArtifactExecutionPlan, Diagnostic } from "../types";

export interface ArtifactSelectionResult {
  artifactNames: string[];
  diagnostics: Diagnostic[];
}

export function resolveArtifactSelection(
  artifactExecutions: ArtifactExecutionPlan[],
  selectorTokens: string[],
): ArtifactSelectionResult {
  const diagnostics: Diagnostic[] = [];
  const runnableArtifacts = dedupeArtifacts(artifactExecutions);
  const normalizedSelectors = selectorTokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (normalizedSelectors.length === 0) {
    return {
      artifactNames: runnableArtifacts.map((artifact) => artifact.artifactName),
      diagnostics,
    };
  }

  const resolvedArtifactNames = new Set<string>();

  for (const selector of normalizedSelectors) {
    const matches = runnableArtifacts.filter((artifact) => buildArtifactAliases(artifact).has(selector.toLowerCase()));
    const uniqueArtifactNames = [...new Set(matches.map((artifact) => artifact.artifactName))];

    if (uniqueArtifactNames.length === 1) {
      resolvedArtifactNames.add(uniqueArtifactNames[0] as string);
      continue;
    }

    if (uniqueArtifactNames.length === 0) {
      diagnostics.push(
        createDiagnostic("error", "artifact-selector-not-found", `Artifact selector "${selector}" did not match any known artifact.`),
      );
      continue;
    }

    diagnostics.push(
      createDiagnostic(
        "error",
        "artifact-selector-ambiguous",
        `Artifact selector "${selector}" is ambiguous: ${uniqueArtifactNames.join(", ")}.`,
      ),
    );
  }

  return {
    artifactNames: [...resolvedArtifactNames],
    diagnostics,
  };
}

function dedupeArtifacts(artifactExecutions: ArtifactExecutionPlan[]): ArtifactExecutionPlan[] {
  const seen = new Set<string>();
  const result: ArtifactExecutionPlan[] = [];

  for (const artifactExecution of artifactExecutions) {
    if (seen.has(artifactExecution.artifactName)) {
      continue;
    }

    seen.add(artifactExecution.artifactName);
    result.push(artifactExecution);
  }

  return result;
}

function buildArtifactAliases(artifact: ArtifactExecutionPlan): Set<string> {
  const aliases = new Set<string>();
  aliases.add(artifact.artifactName.toLowerCase());

  if (artifact.packageName) {
    const packageName = artifact.packageName.toLowerCase();
    aliases.add(packageName);
    aliases.add(stripScope(packageName));
    aliases.add(stripEnvHeavenPrefix(stripScope(packageName)));
  }

  if (artifact.repoCloneFolderPath) {
    const normalizedPath = artifact.repoCloneFolderPath.replace(/\\/g, "/").toLowerCase();
    const segments = normalizedPath.split("/");
    aliases.add(segments[segments.length - 1] as string);
  }

  return aliases;
}

function stripScope(packageName: string): string {
  return packageName.startsWith("@") ? packageName.split("/")[1] ?? packageName : packageName;
}

function stripEnvHeavenPrefix(value: string): string {
  return value.startsWith("envheaven-") ? value.slice("envheaven-".length) : value;
}
