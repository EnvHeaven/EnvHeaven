import type { SpawnRequest, SpawnResult } from "../types";
export declare function spawnExecution(request: SpawnRequest): Promise<SpawnResult>;
export declare function buildSpawnPlan(request: SpawnRequest, platform: NodeJS.Platform): SpawnPlan;
export declare function buildSpawnEnv(parentEnv: NodeJS.ProcessEnv, extraEnv: Record<string, string>, platform: NodeJS.Platform): NodeJS.ProcessEnv;
export declare function buildWindowsCommandLine(command: string, args: string[]): string;
export interface SpawnPlan {
    command: string;
    args: string[];
    windowsCommandWrappingUsed: boolean;
}
