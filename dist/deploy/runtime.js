"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readPackageMetadata = readPackageMetadata;
exports.withTemporaryPackageVersion = withTemporaryPackageVersion;
exports.withPermanentPackageVersion = withPermanentPackageVersion;
exports.createArtifactDeployTag = createArtifactDeployTag;
exports.buildMissingProductionVersionDiagnostic = buildMissingProductionVersionDiagnostic;
exports.computeNextVersionSuggestion = computeNextVersionSuggestion;
exports.stageAndPackLocal = stageAndPackLocal;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const diagnostics_1 = require("../diagnostics");
const store_1 = require("../state/store");
async function readPackageMetadata(packageDirectory) {
    const packageJsonPath = node_path_1.default.join(packageDirectory, "package.json");
    const raw = await node_fs_1.promises.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
        name: typeof parsed.name === "string" ? parsed.name : node_path_1.default.basename(packageDirectory),
        version: typeof parsed.version === "string" ? parsed.version : "0.1.0",
        packageJsonPath,
    };
}
async function withTemporaryPackageVersion(packageDirectory, targetVersion, action) {
    if (!(0, store_1.isValidVersionString)(targetVersion)) {
        throw new Error(`Invalid package version "${targetVersion}".`);
    }
    const packageJsonPath = node_path_1.default.join(packageDirectory, "package.json");
    const originalContent = await node_fs_1.promises.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(originalContent);
    parsed.version = targetVersion;
    await node_fs_1.promises.writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    try {
        return await action();
    }
    finally {
        await node_fs_1.promises.writeFile(packageJsonPath, originalContent, "utf8");
    }
}
async function withPermanentPackageVersion(packageDirectory, targetVersion, action) {
    if (!(0, store_1.isValidVersionString)(targetVersion)) {
        throw new Error(`Invalid package version "${targetVersion}".`);
    }
    const packageJsonPath = node_path_1.default.join(packageDirectory, "package.json");
    const originalContent = await node_fs_1.promises.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(originalContent);
    parsed.version = targetVersion;
    await node_fs_1.promises.writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return await action();
}
async function createArtifactDeployTag(repoRoot, artifactDirectory, version, deployTarget) {
    const relativeArtifactPath = node_path_1.default.relative(repoRoot, artifactDirectory);
    const repoTopLevel = await runGitAndCapture(["-C", artifactDirectory, "rev-parse", "--show-toplevel"]);
    const normalizedTopLevel = node_path_1.default.resolve(repoTopLevel.stdout.trim());
    const normalizedArtifactDirectory = node_path_1.default.resolve(artifactDirectory);
    if (repoTopLevel.exitCode !== 0 || normalizedTopLevel !== normalizedArtifactDirectory) {
        return {
            tagName: "",
            created: false,
            pushed: false,
            message: `Skipping tag creation because "${relativeArtifactPath}" is not an isolated git repo.`,
        };
    }
    const tagName = `build-v${version}_${deployTarget}`;
    const existingTag = await runGitAndCapture(["-C", artifactDirectory, "tag", "--list", tagName]);
    if (existingTag.stdout.trim() === tagName) {
        return {
            tagName,
            created: false,
            pushed: false,
            message: `Tag "${tagName}" already exists in ${relativeArtifactPath}.`,
        };
    }
    const createResult = await runGitAndCapture(["-C", artifactDirectory, "tag", tagName]);
    if (createResult.exitCode !== 0) {
        return {
            tagName,
            created: false,
            pushed: false,
            message: createResult.stderr || `Failed to create tag "${tagName}".`,
        };
    }
    let pushed = false;
    if (process.env.EH_GIT_PUSH_TAGS === "1") {
        const pushResult = await runGitAndCapture(["-C", artifactDirectory, "push", "origin", `refs/tags/${tagName}`]);
        pushed = pushResult.exitCode === 0;
        if (!pushed) {
            return {
                tagName,
                created: true,
                pushed: false,
                message: pushResult.stderr || `Tag "${tagName}" was created locally but failed to push.`,
            };
        }
    }
    return {
        tagName,
        created: true,
        pushed,
    };
}
function buildMissingProductionVersionDiagnostic(artifactName, packageVersion) {
    return (0, diagnostics_1.createDiagnostic)("warning", "production-version-fallback", `Artifact "${artifactName}" has no configured next version; falling back to package.json version "${packageVersion}".`);
}
function computeNextVersionSuggestion(version) {
    return (0, store_1.incrementPatchVersion)(version);
}
const STAGING_EXCLUDE = new Set([
    "node_modules",
    ".git",
    ".angular",
    ".replit-artifact",
    ".replit",
]);
async function copyTree(src, dest) {
    const entries = await node_fs_1.promises.readdir(src, { withFileTypes: true });
    await node_fs_1.promises.mkdir(dest, { recursive: true });
    for (const entry of entries) {
        if (STAGING_EXCLUDE.has(entry.name))
            continue;
        const srcPath = node_path_1.default.join(src, entry.name);
        const destPath = node_path_1.default.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyTree(srcPath, destPath);
        }
        else {
            await node_fs_1.promises.copyFile(srcPath, destPath);
        }
    }
}
async function stageAndPackLocal(packageDirectory, targetVersion, persistentCacheDir) {
    if (!(0, store_1.isValidVersionString)(targetVersion)) {
        throw new Error(`Invalid package version "${targetVersion}".`);
    }
    const meta = await readPackageMetadata(packageDirectory);
    const safeName = meta.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    let stagingDir;
    if (persistentCacheDir) {
        stagingDir = node_path_1.default.join(persistentCacheDir, "staging", safeName);
        await node_fs_1.promises.mkdir(stagingDir, { recursive: true });
    }
    else {
        stagingDir = await node_fs_1.promises.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "envheaven-stage-"));
    }
    const staged = node_path_1.default.join(stagingDir, "package");
    await node_fs_1.promises.rm(staged, { recursive: true, force: true }).catch(() => { });
    await copyTree(packageDirectory, staged);
    const stagedPkgJsonPath = node_path_1.default.join(staged, "package.json");
    const raw = await node_fs_1.promises.readFile(stagedPkgJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    parsed.version = targetVersion;
    await node_fs_1.promises.writeFile(stagedPkgJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const tarballName = "package.tgz";
    const tarballPath = node_path_1.default.join(stagingDir, tarballName);
    const packResult = await runCommandAndCapture("tar", ["czf", tarballPath, "-C", stagingDir, "package"], stagingDir);
    if (packResult.exitCode !== 0) {
        await node_fs_1.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => { });
        throw new Error(`tar pack failed (exit ${String(packResult.exitCode)}): ${packResult.stderr}`);
    }
    return {
        tarballPath,
        stagingDir,
        cleanup: async () => {
            if (!persistentCacheDir) {
                await node_fs_1.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => { });
            }
        },
    };
}
async function runCommandAndCapture(command, args, cwd) {
    return await new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)(command, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("close", (exitCode) => {
            resolve({ exitCode: exitCode ?? 1, stdout, stderr });
        });
        child.on("error", (error) => {
            resolve({ exitCode: 1, stdout, stderr: error.message });
        });
    });
}
async function runGitAndCapture(args) {
    return await new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)("git", args, {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("close", (exitCode) => {
            resolve({
                exitCode: exitCode ?? 1,
                stdout,
                stderr,
            });
        });
        child.on("error", (error) => {
            resolve({
                exitCode: 1,
                stdout,
                stderr: error.message,
            });
        });
    });
}
