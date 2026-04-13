import type { Diagnostic } from "../types";
export interface BuildContext {
    version: string;
    target: string;
    envMapName: string;
    variables: Record<string, string>;
    timestamp: string;
    artifactName: string;
}
export interface MaterializationResult {
    contextFilePath: string;
    diagnostics: Diagnostic[];
}
export declare function resolveBuildVersion(storeNextVersion: string | null | undefined, storeLastVersion: string | null | undefined, packageJsonVersion: string): string;
export declare function resolveVariables(envVars: Record<string, string>, resolvedTarget: string, resolvedVersion: string, extraOverrides?: Record<string, string>): Record<string, string>;
export declare function buildBuildContext(artifactName: string, resolvedTarget: string, envMapName: string, resolvedVersion: string, envVars: Record<string, string>): BuildContext;
export declare function materializeBuildContext(outputDirectory: string, context: BuildContext): Promise<MaterializationResult>;
export declare function readBuildContext(directory: string): Promise<BuildContext | null>;
export declare function cleanBuildContext(directory: string): Promise<Diagnostic[]>;
