import http from "node:http";
import { EnvHeavenStateStore } from "../state/store";
export interface DaemonWsEvent {
    type: string;
    payload: unknown;
}
export declare function startDaemon(rootDirectory: string, port?: number, stateStore?: EnvHeavenStateStore, daemonVersion?: string): Promise<{
    server: http.Server;
    killAllRuns: () => void;
}>;
