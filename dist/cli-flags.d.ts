import type { GlobalOptions } from "./types";
export interface ParsedGlobalFlags {
    options: GlobalOptions;
    remainingArgs: string[];
}
export declare function parseGlobalFlags(argv: string[]): ParsedGlobalFlags;
