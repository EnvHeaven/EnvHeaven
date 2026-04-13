"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveArtifactSelection = resolveArtifactSelection;
const diagnostics_1 = require("../diagnostics");
function resolveArtifactSelection(artifactExecutions, selectorTokens) {
    const diagnostics = [];
    const runnableArtifacts = dedupeArtifacts(artifactExecutions);
    const normalizedSelectors = selectorTokens
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
    if (normalizedSelectors.length === 0 || normalizedSelectors.some((token) => token === "all")) {
        return {
            artifactNames: runnableArtifacts.map((artifact) => artifact.artifactName),
            diagnostics,
        };
    }
    const resolvedArtifactNames = new Set();
    for (const selector of normalizedSelectors) {
        const matches = runnableArtifacts.filter((artifact) => buildArtifactAliases(artifact).has(selector.toLowerCase()));
        const uniqueArtifactNames = [...new Set(matches.map((artifact) => artifact.artifactName))];
        if (uniqueArtifactNames.length === 1) {
            resolvedArtifactNames.add(uniqueArtifactNames[0]);
            continue;
        }
        if (uniqueArtifactNames.length === 0) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "artifact-selector-not-found", `Artifact selector "${selector}" did not match any known artifact.`));
            continue;
        }
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "artifact-selector-ambiguous", `Artifact selector "${selector}" is ambiguous: ${uniqueArtifactNames.join(", ")}.`));
    }
    return {
        artifactNames: [...resolvedArtifactNames],
        diagnostics,
    };
}
function dedupeArtifacts(artifactExecutions) {
    const seen = new Set();
    const result = [];
    for (const artifactExecution of artifactExecutions) {
        if (seen.has(artifactExecution.artifactName)) {
            continue;
        }
        seen.add(artifactExecution.artifactName);
        result.push(artifactExecution);
    }
    return result;
}
function buildArtifactAliases(artifact) {
    const aliases = new Set();
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
        aliases.add(segments[segments.length - 1]);
    }
    return aliases;
}
function stripScope(packageName) {
    return packageName.startsWith("@") ? packageName.split("/")[1] ?? packageName : packageName;
}
function stripEnvHeavenPrefix(value) {
    return value.startsWith("envheaven-") ? value.slice("envheaven-".length) : value;
}
