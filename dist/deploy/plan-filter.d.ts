import type { ArtifactExecutionPlan, ExecutionSpec } from "../types";
export declare function applyPnpmRecursiveFilter(execution: ExecutionSpec | null, artifactExecutions: ArtifactExecutionPlan[], selectedArtifacts: string[]): ExecutionSpec | null;
export declare function isLocalGlobalInstall(command: string | undefined, args: string[]): boolean;
