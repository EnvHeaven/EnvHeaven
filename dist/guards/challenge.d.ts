import type { Readable, Writable } from "node:stream";
import type { Diagnostic } from "../types";
export interface ChallengeRequirement {
    targetName: string;
    suffix: string;
    phrase: string;
    reason: string;
}
export interface ChallengeGuardResult {
    passed: boolean;
    diagnostics: Diagnostic[];
    requirement: ChallengeRequirement | null;
}
export interface DeployGuardMetadata {
    requireChallenge?: boolean;
    reason?: string;
}
export declare function generateChallengeSuffix(): string;
export declare function buildChallengeRequirement(targetName: string, guardMetadata: DeployGuardMetadata | null): ChallengeRequirement | null;
export declare function buildChallengeFromResolvedModel(resolvedModel: Record<string, unknown>, resolvedTarget: string): ChallengeRequirement | null;
export declare function executeCliChallenge(requirement: ChallengeRequirement): Promise<ChallengeGuardResult>;
export declare function buildWebUiChallengePayload(requirement: ChallengeRequirement): Record<string, unknown>;
export declare function validateWebUiChallengeResponse(requirement: ChallengeRequirement, response: string): ChallengeGuardResult;
export declare function readLineFromStreams(input?: Readable, output?: Writable): Promise<string>;
export declare function shouldUseTerminalReadline(input: Readable, output: Writable): boolean;
