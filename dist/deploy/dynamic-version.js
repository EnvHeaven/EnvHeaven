"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.materializeDynamicVersionToken = materializeDynamicVersionToken;
exports.materializeDynamicVersionExecution = materializeDynamicVersionExecution;
const DYNAMIC_ARTIFACT_VERSION_TOKEN = "dynamic-artifact-version";
const DYNAMIC_ARTIFACT_VERSION_LITERAL_PATTERN = /(^|[^A-Za-z0-9_])dynamic-artifact-version(?=$|[^A-Za-z0-9_])/g;
const DYNAMIC_ARTIFACT_VERSION_FUNCTION_PATTERN = /\{\{\s*GetDynamicArtifactVersionOf\((['"`])([^'"`]+)\1\)\s*\}\}/g;
function materializeDynamicVersionToken(value, artifactName, resolvedVersion, artifactVersions = {}) {
    const withFunctionTemplates = value.replace(DYNAMIC_ARTIFACT_VERSION_FUNCTION_PATTERN, (match, _quote, tokenArtifactName) => artifactVersions[tokenArtifactName] ?? (tokenArtifactName === artifactName ? resolvedVersion : match));
    return withFunctionTemplates.replace(DYNAMIC_ARTIFACT_VERSION_LITERAL_PATTERN, (match, prefix) => `${prefix}${match.slice(prefix.length).replace(DYNAMIC_ARTIFACT_VERSION_TOKEN, resolvedVersion)}`);
}
function materializeDynamicVersionExecution(execution, artifactName, resolvedVersion, artifactVersions = {}) {
    return {
        ...execution,
        args: execution.args.map((arg) => materializeDynamicVersionToken(arg, artifactName, resolvedVersion, artifactVersions)),
        env: Object.fromEntries(Object.entries(execution.env).map(([key, value]) => [
            key,
            materializeDynamicVersionToken(value, artifactName, resolvedVersion, artifactVersions),
        ])),
    };
}
