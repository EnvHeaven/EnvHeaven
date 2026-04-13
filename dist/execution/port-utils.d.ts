export interface PortKillResult {
    port: number;
    wasInUse: boolean;
    killed: boolean;
    pid: number | null;
}
export declare function isPortInUse(port: number): Promise<boolean>;
export declare function findPidOnPort(port: number): number | null;
export declare function killPortHolder(port: number, timeoutMs?: number): Promise<PortKillResult>;
export declare function extractPortFromExecution(args: string[], env: Record<string, string>): number | null;
