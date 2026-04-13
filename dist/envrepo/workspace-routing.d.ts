import type { Diagnostic } from "../types";
export interface WorkspaceRoutingResult {
    envRepoRoot: string;
    artifactContext: ArtifactContext | null;
    diagnostics: Diagnostic[];
}
export interface ArtifactContext {
    artifactDirectory: string;
    artifactRelativePath: string;
    artifactName: string | null;
}
export declare function resolveWorkspaceRoot(startDirectory: string): Promise<WorkspaceRoutingResult>;
export declare function matchArtifactToEnvMap(artifactRelativePath: string, artifacts: Record<string, Record<string, unknown>>): string | null;
