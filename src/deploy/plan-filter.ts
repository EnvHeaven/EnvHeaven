import type { ArtifactExecutionPlan, ExecutionSpec } from "../types";

export function applyPnpmRecursiveFilter(
  execution: ExecutionSpec | null,
  artifactExecutions: ArtifactExecutionPlan[],
  selectedArtifacts: string[],
): ExecutionSpec | null {
  if (!execution || execution.command !== "pnpm") return execution;
  if (selectedArtifacts.length === 0) return execution;
  const rFlagIndex = execution.args.indexOf("-r");
  if (rFlagIndex === -1) return execution;
  const packageNames = artifactExecutions.map((ae) => ae.packageName).filter((n): n is string => Boolean(n));
  if (packageNames.length === 0) return execution;
  const filterArgs = packageNames.flatMap((pkg) => ["--filter", pkg]);
  const newArgs = [...execution.args.slice(0, rFlagIndex), ...filterArgs, ...execution.args.slice(rFlagIndex + 1)];
  return { ...execution, args: newArgs };
}

export function isLocalGlobalInstall(command: string | undefined, args: string[]): boolean {
  return command === "pnpm" && args[0] === "add" && args[1] === "--global";
}
