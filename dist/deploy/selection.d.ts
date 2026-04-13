import type { ArtifactExecutionPlan, Diagnostic } from "../types";
export interface ArtifactSelectionResult {
    artifactNames: string[];
    diagnostics: Diagnostic[];
}
export declare function resolveArtifactSelection(artifactExecutions: ArtifactExecutionPlan[], selectorTokens: string[]): ArtifactSelectionResult;
