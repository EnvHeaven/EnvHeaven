import http from "node:http";
import { EnvHeavenStateStore } from "../state/store";
import type { RepoModel } from "../types";
export interface DaemonWsEvent {
    type: string;
    payload: unknown;
}
export declare function buildPtyDisplayPrelude(repoRoot: string, runCommand: string): string;
export declare function startDaemon(rootDirectory: string, port?: number, stateStore?: EnvHeavenStateStore, daemonVersion?: string): Promise<{
    server: http.Server;
    killAllRuns: () => void;
}>;
export declare function buildVersionPayload(repoModel: RepoModel, repoRoot: string, stateStore: EnvHeavenStateStore): Promise<Array<Record<string, unknown>>>;
