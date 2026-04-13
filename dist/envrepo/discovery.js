"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverEnvRepo = discoverEnvRepo;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const jsonc_parser_1 = require("jsonc-parser");
const diagnostics_1 = require("../diagnostics");
const ENV_DIR_NAME = ".envheaven";
const FILE_SUFFIX = ".envheaven.env-map-layer.json";
async function discoverEnvRepo(rootDirectory) {
    const envDirectories = await findEnvDirectories(rootDirectory);
    const files = [];
    const diagnostics = [];
    for (const envDirectory of envDirectories.sort()) {
        const discoveredFiles = await collectLayerFiles(envDirectory);
        files.push(...discoveredFiles);
    }
    files.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    if (envDirectories.length === 0) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "env-directory-missing", "No .envheaven directory was discovered.", rootDirectory));
    }
    for (const file of files) {
        diagnostics.push(...file.diagnostics);
    }
    return {
        rootDirectory,
        envDirectories,
        files,
        diagnostics,
    };
}
async function findEnvDirectories(rootDirectory) {
    // Look for .envheaven in rootDirectory first. If found, use it exclusively
    // so that nested submodule configs are not accidentally merged in.
    // If not found, walk up ancestor directories to locate the nearest config.
    const localEnvDir = node_path_1.default.join(rootDirectory, ENV_DIR_NAME);
    try {
        const stat = await node_fs_1.promises.stat(localEnvDir);
        if (stat.isDirectory()) {
            return [localEnvDir];
        }
    }
    catch {
        // Not present — fall through to ancestor search.
    }
    // Walk up the directory tree to find the nearest ancestor with .envheaven.
    let current = node_path_1.default.dirname(rootDirectory);
    while (current !== node_path_1.default.dirname(current)) {
        const ancestorEnvDir = node_path_1.default.join(current, ENV_DIR_NAME);
        try {
            const stat = await node_fs_1.promises.stat(ancestorEnvDir);
            if (stat.isDirectory()) {
                return [ancestorEnvDir];
            }
        }
        catch {
            // Not present — keep walking up.
        }
        current = node_path_1.default.dirname(current);
    }
    return [];
}
async function collectLayerFiles(envDirectory) {
    const files = [];
    await walkEnvDirectory(envDirectory, async (filePath) => {
        if (!filePath.endsWith(FILE_SUFFIX)) {
            return;
        }
        files.push(await parseEnvRepoFile(envDirectory, filePath));
    });
    return files;
}
async function walkEnvDirectory(currentDirectory, onFile) {
    const entries = await node_fs_1.promises.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
        const resolvedPath = node_path_1.default.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
            await walkEnvDirectory(resolvedPath, onFile);
            continue;
        }
        if (entry.isFile()) {
            await onFile(resolvedPath);
        }
    }
}
async function parseEnvRepoFile(envDirectory, filePath) {
    const diagnostics = [];
    try {
        const raw = await node_fs_1.promises.readFile(filePath, "utf8");
        const errors = [];
        const payload = (0, jsonc_parser_1.parse)(raw, errors, {
            allowTrailingComma: true,
            disallowComments: false,
        });
        for (const error of errors) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "jsonc-parse-error", `Failed to parse JSONC: ${(0, jsonc_parser_1.printParseErrorCode)(error.error)} at offset ${error.offset}.`, filePath));
        }
        return {
            sourcePath: filePath,
            relativePath: node_path_1.default.relative(envDirectory, filePath),
            fileName: node_path_1.default.basename(filePath),
            payload: isRecord(payload) ? payload : null,
            diagnostics,
        };
    }
    catch (error) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "file-read-error", error instanceof Error ? error.message : "Unknown file read error.", filePath));
        return {
            sourcePath: filePath,
            relativePath: node_path_1.default.relative(envDirectory, filePath),
            fileName: node_path_1.default.basename(filePath),
            payload: null,
            diagnostics,
        };
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
