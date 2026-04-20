"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPlugin = loadPlugin;
const node_child_process_1 = require("node:child_process");
const node_module_1 = require("node:module");
const node_path_1 = __importDefault(require("node:path"));
const diagnostics_1 = require("../diagnostics");
const LEGACY_PACKAGE_RENAMES = {
    "@envheaven/plugins/nodejs-pnpm": "@envheaven/plugins-nodejs-pnpm",
    "@envheaven/plugins/firebase-hosting-deploy": "@envheaven/plugins-firebase-hosting-deploy",
};
async function loadPlugin(packageName, repoRoot) {
    const diagnostics = [];
    const packageValidation = validatePackageName(packageName);
    if (packageValidation) {
        diagnostics.push(packageValidation);
        return {
            packageName,
            resolvedPath: "",
            plugin: {},
            diagnostics,
        };
    }
    const localRequire = (0, node_module_1.createRequire)(node_path_1.default.join(repoRoot, "package.json"));
    try {
        return loadPluginFromRequire(packageName, localRequire, diagnostics);
    }
    catch (error) {
        const globalErrorMessages = [];
        for (const globalModulesRoot of getGlobalModulesRoots()) {
            try {
                const globalRequire = (0, node_module_1.createRequire)(node_path_1.default.join(globalModulesRoot, "package.json"));
                return loadPluginFromRequire(packageName, globalRequire, diagnostics);
            }
            catch (globalError) {
                globalErrorMessages.push(globalError instanceof Error ? globalError.message : String(globalError));
            }
        }
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "plugin-load-failed", error instanceof Error ? error.message : `Failed to load "${packageName}".`, repoRoot, globalErrorMessages.length > 0 ? { globalErrorMessages } : undefined));
        return {
            packageName,
            resolvedPath: "",
            plugin: {},
            diagnostics,
        };
    }
}
function loadPluginFromRequire(packageName, requireFn, diagnostics) {
    const resolvedPath = requireFn.resolve(packageName);
    const imported = requireFn(resolvedPath);
    const plugin = normalizePlugin(imported);
    if (!plugin.inspect && !plugin.execute) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "plugin-contract-invalid", `Plugin "${packageName}" must export inspect() and/or execute().`, resolvedPath));
    }
    return {
        packageName,
        resolvedPath,
        plugin,
        diagnostics,
    };
}
function getGlobalModulesRoots() {
    const roots = new Set();
    const envRoot = process.env.ENVHEAVEN_GLOBAL_NODE_MODULES;
    if (envRoot) {
        roots.add(envRoot);
    }
    for (const command of ["pnpm", "npm"]) {
        try {
            const output = (0, node_child_process_1.execFileSync)(command, ["root", "-g"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (output) {
                roots.add(output);
            }
        }
        catch {
            // Ignore global package manager lookup failures.
        }
    }
    return [...roots];
}
function validatePackageName(packageName) {
    const suggestedName = LEGACY_PACKAGE_RENAMES[packageName];
    if (suggestedName) {
        return (0, diagnostics_1.createDiagnostic)("error", "plugin-package-name-invalid", `Invalid plugin package name "${packageName}". Use "${suggestedName}" instead.`);
    }
    const slashCount = [...packageName].filter((character) => character === "/").length;
    const isScoped = packageName.startsWith("@");
    if ((isScoped && slashCount !== 1) || (!isScoped && slashCount !== 0)) {
        return (0, diagnostics_1.createDiagnostic)("error", "plugin-package-name-invalid", `Invalid npm package name "${packageName}". Scoped packages must use "@scope/name".`);
    }
    const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
    if (!packageNamePattern.test(packageName)) {
        return (0, diagnostics_1.createDiagnostic)("error", "plugin-package-name-invalid", `Invalid npm package name "${packageName}".`);
    }
    return null;
}
function normalizePlugin(imported) {
    if (isPlugin(imported)) {
        return imported;
    }
    if (imported && typeof imported === "object" && "default" in imported && isPlugin(imported.default)) {
        return imported.default;
    }
    return {};
}
function isPlugin(value) {
    return typeof value === "object" && value !== null;
}
