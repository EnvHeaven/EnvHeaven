import type { EnvHeavenPaths } from "./store";
export interface RunLockFile {
    daemonPort: number;
    uiPort: number | null;
    startedAt: string;
    daemonPid?: number;
    uiPid?: number;
}
export declare function getLockFilePath(paths: EnvHeavenPaths): string;
export declare function readLockFile(paths: EnvHeavenPaths): Promise<RunLockFile | null>;
export declare function writeLockFile(paths: EnvHeavenPaths, lock: RunLockFile): Promise<void>;
export declare function clearLockFile(paths: EnvHeavenPaths): Promise<void>;
export declare function isPortOpen(port: number, host?: string): Promise<boolean>;
/**
 * Poll until lock file exists and daemon port is reachable.
 * Pass requireUiPort=true to also wait until uiPort is present and reachable.
 */
export declare function waitForLockFile(paths: EnvHeavenPaths, timeoutMs?: number, pollIntervalMs?: number, requireUiPort?: boolean): Promise<RunLockFile | null>;
