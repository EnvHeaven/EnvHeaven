import type { CommandIntent, Diagnostic } from "../types";
export declare function inferCommandIntent(args: string[]): {
    intent: CommandIntent | null;
    diagnostics: Diagnostic[];
};
