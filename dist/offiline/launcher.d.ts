import type http from "node:http";
import { EnvHeavenStateStore } from "../state/store";
export declare function launchOffilineWebUi(repoRoot: string, daemonUrl: string, store: EnvHeavenStateStore, port?: number): Promise<{
    uiUrl: string;
    server: http.Server;
    source: "local-workspace" | "user-cache";
}>;
