"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveBuildVersion = resolveBuildVersion;
exports.resolveVariables = resolveVariables;
exports.buildBuildContext = buildBuildContext;
exports.materializeBuildContext = materializeBuildContext;
exports.readBuildContext = readBuildContext;
exports.cleanBuildContext = cleanBuildContext;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const diagnostics_1 = require("../diagnostics");
const BUILD_CONTEXT_FILENAME = ".envheaven-build-context.json";
function resolveBuildVersion(storeNextVersion, storeLastVersion, packageJsonVersion) {
    if (storeNextVersion && storeNextVersion.length > 0) {
        return storeNextVersion;
    }
    if (storeLastVersion && storeLastVersion.length > 0) {
        return storeLastVersion;
    }
    return packageJsonVersion;
}
function resolveVariables(envVars, resolvedTarget, resolvedVersion, extraOverrides) {
    const variables = {
        ...envVars,
        EH_DEPLOY_TARGET: resolvedTarget,
        EH_ARTIFACT_VERSION: resolvedVersion,
        EH_BUILD_TIMESTAMP: new Date().toISOString(),
    };
    if (extraOverrides) {
        Object.assign(variables, extraOverrides);
    }
    return variables;
}
function buildBuildContext(artifactName, resolvedTarget, envMapName, resolvedVersion, envVars) {
    return {
        version: resolvedVersion,
        target: resolvedTarget,
        envMapName,
        variables: resolveVariables(envVars, resolvedTarget, resolvedVersion),
        timestamp: new Date().toISOString(),
        artifactName,
    };
}
async function materializeBuildContext(outputDirectory, context) {
    const diagnostics = [];
    const contextFilePath = node_path_1.default.join(outputDirectory, BUILD_CONTEXT_FILENAME);
    try {
        await node_fs_1.promises.mkdir(outputDirectory, { recursive: true });
        await node_fs_1.promises.writeFile(contextFilePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
        diagnostics.push((0, diagnostics_1.createDiagnostic)("info", "build-context-materialized", `Build context written to "${contextFilePath}".`));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "build-context-write-failed", `Failed to write build context: ${msg}`));
    }
    return { contextFilePath, diagnostics };
}
async function readBuildContext(directory) {
    const contextFilePath = node_path_1.default.join(directory, BUILD_CONTEXT_FILENAME);
    try {
        const raw = await node_fs_1.promises.readFile(contextFilePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
async function cleanBuildContext(directory) {
    const contextFilePath = node_path_1.default.join(directory, BUILD_CONTEXT_FILENAME);
    try {
        await node_fs_1.promises.unlink(contextFilePath);
        return [
            (0, diagnostics_1.createDiagnostic)("info", "build-context-cleaned", `Build context removed from "${contextFilePath}".`),
        ];
    }
    catch {
        return [];
    }
}
