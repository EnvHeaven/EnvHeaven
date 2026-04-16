import type { ExecutionSpec } from "../types";
export declare function materializeDynamicVersionToken(value: string, artifactName: string, resolvedVersion: string, artifactVersions?: Record<string, string>): string;
export declare function materializeDynamicVersionExecution(execution: ExecutionSpec, artifactName: string, resolvedVersion: string, artifactVersions?: Record<string, string>): ExecutionSpec;
