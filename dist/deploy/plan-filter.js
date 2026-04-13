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
    const packageNames = artifactExecutions.map((ae) => ae.packageName).filter((n) => Boolean(n));
    if (packageNames.length === 0)
        return execution;
    const filterArgs = packageNames.flatMap((pkg) => ["--filter", pkg]);
    const newArgs = [...execution.args.slice(0, rFlagIndex), ...filterArgs, ...execution.args.slice(rFlagIndex + 1)];
    return { ...execution, args: newArgs };
}
function isLocalGlobalInstall(command, args) {
    return command === "pnpm" && args[0] === "add" && args[1] === "--global";
}
