"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyPnpmRecursiveFilter = applyPnpmRecursiveFilter;
exports.isLocalGlobalInstall = isLocalGlobalInstall;
function applyPnpmRecursiveFilter(execution, artifactExecutions, selectedArtifacts) {
    if (!execution || execution.command !== "pnpm")
        return execution;
    if (selectedArtifacts.length === 0)
        return execution;
    const rFlagIndex = execution.args.indexOf("-r");
    if (rFlagIndex === -1)
        return execution;
    const filters = uniqueStrings(artifactExecutions.flatMap((ae) => {
        const pathFilter = normalizePathFilter(ae.repoCloneFolderPath);
        return pathFilter ? [pathFilter] : ae.packageName ? [ae.packageName] : [];
    }));
    if (filters.length === 0)
        return execution;
    const filterArgs = [...filters.flatMap((filter) => ["--filter", filter]), "--fail-if-no-match"];
    const newArgs = [...execution.args.slice(0, rFlagIndex), ...filterArgs, ...execution.args.slice(rFlagIndex + 1)];
    return { ...execution, args: newArgs };
}
function isLocalGlobalInstall(command, args) {
    return command === "pnpm" && args[0] === "add" && args[1] === "--global";
}
function normalizePathFilter(value) {
    const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
    if (!normalized)
        return null;
    if (normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../")) {
        return normalized;
    }
    return `./${normalized}`;
}
function uniqueStrings(values) {
    return [...new Set(values)];
}
