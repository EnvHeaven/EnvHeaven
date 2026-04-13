"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWorkspaceRoot = resolveWorkspaceRoot;
exports.matchArtifactToEnvMap = matchArtifactToEnvMap;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const diagnostics_1 = require("../diagnostics");
const ENV_DIR_NAME = ".envheaven";
const ARTIFACT_MARKERS = ["package.json", "angular.json", "tsconfig.json"];
async function resolveWorkspaceRoot(startDirectory) {
    const diagnostics = [];
    const localEnvDir = node_path_1.default.join(startDirectory, ENV_DIR_NAME);
    if (await isDirectory(localEnvDir)) {
        return {
            envRepoRoot: startDirectory,
            artifactContext: null,
            diagnostics,
        };
    }
    let current = startDirectory;
    const traversed = [];
    while (true) {
        const parent = node_path_1.default.dirname(current);
        if (parent === current)
            break;
        traversed.push(current);
        current = parent;
        const ancestorEnvDir = node_path_1.default.join(current, ENV_DIR_NAME);
        if (await isDirectory(ancestorEnvDir)) {
            const artifactContext = await detectArtifactContext(startDirectory, current);
            if (artifactContext) {
                diagnostics.push((0, diagnostics_1.createDiagnostic)("info", "workspace-routing-resolved", `Resolved workspace root at "${current}" from artifact directory "${startDirectory}".`));
            }
            return {
                envRepoRoot: current,
                artifactContext,
                diagnostics,
            };
        }
    }
    diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "workspace-routing-not-found", `No .envheaven directory found in "${startDirectory}" or any ancestor.`));
    return {
        envRepoRoot: startDirectory,
        artifactContext: null,
        diagnostics,
    };
}
async function detectArtifactContext(artifactDirectory, envRepoRoot) {
    const isArtifact = await isLikelyArtifactDirectory(artifactDirectory);
    if (!isArtifact)
        return null;
    const relativePath = node_path_1.default.relative(envRepoRoot, artifactDirectory);
    if (relativePath.startsWith(".."))
        return null;
    const artifactName = await readArtifactNameFromPackageJson(artifactDirectory);
    return {
        artifactDirectory,
        artifactRelativePath: `./${relativePath}`,
        artifactName,
    };
}
async function isLikelyArtifactDirectory(dir) {
    for (const marker of ARTIFACT_MARKERS) {
        if (await fileExists(node_path_1.default.join(dir, marker))) {
            return true;
        }
    }
    return false;
}
async function readArtifactNameFromPackageJson(dir) {
    try {
        const raw = await node_fs_1.promises.readFile(node_path_1.default.join(dir, "package.json"), "utf8");
        const parsed = JSON.parse(raw);
        return typeof parsed.name === "string" ? parsed.name : null;
    }
    catch {
        return null;
    }
}
function matchArtifactToEnvMap(artifactRelativePath, artifacts) {
    const normalizedPath = artifactRelativePath.replace(/\\/g, "/");
    for (const [artifactName, artifactConfig] of Object.entries(artifacts)) {
        const repoClonePath = artifactConfig["RepoCloneFolderPath"] ??
            artifactConfig["repoCloneFolderPath"];
        if (!repoClonePath)
            continue;
        const normalizedClonePath = repoClonePath.replace(/\\/g, "/");
        if (normalizedPath === normalizedClonePath ||
            normalizedPath === normalizedClonePath.replace(/^\.\//, "")) {
            return artifactName;
        }
    }
    return null;
}
async function isDirectory(dirPath) {
    try {
        const stat = await node_fs_1.promises.stat(dirPath);
        return stat.isDirectory();
    }
    catch {
        return false;
    }
}
async function fileExists(filePath) {
    try {
        await node_fs_1.promises.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
