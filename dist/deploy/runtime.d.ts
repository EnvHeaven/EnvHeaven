import type { Diagnostic } from "../types";
export interface PackageMetadata {
    name: string;
    version: string;
    packageJsonPath: string;
}
export declare function readPackageMetadata(packageDirectory: string): Promise<PackageMetadata>;
export declare function withTemporaryPackageVersion<T>(packageDirectory: string, targetVersion: string, action: () => Promise<T>): Promise<T>;
export declare function withPermanentPackageVersion<T>(packageDirectory: string, targetVersion: string, action: () => Promise<T>): Promise<T>;
export declare function createArtifactDeployTag(repoRoot: string, artifactDirectory: string, version: string, deployTarget: string): Promise<{
    tagName: string;
    created: boolean;
    pushed: boolean;
    message?: string;
}>;
export declare function buildMissingProductionVersionDiagnostic(artifactName: string, packageVersion: string): Diagnostic;
export declare function computeNextVersionSuggestion(version: string): string;
export interface StagedPackage {
    tarballPath: string;
    stagingDir: string;
    cleanup: () => Promise<void>;
}
export declare function stageAndPackLocal(packageDirectory: string, targetVersion: string, persistentCacheDir?: string): Promise<StagedPackage>;
