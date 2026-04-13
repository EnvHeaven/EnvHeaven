import type { Diagnostic, DiagnosticSeverity } from "./types";
export declare function createDiagnostic(severity: DiagnosticSeverity, code: string, message: string, path?: string, details?: Record<string, unknown>): Diagnostic;
export declare function hasErrors(diagnostics: Diagnostic[]): boolean;
