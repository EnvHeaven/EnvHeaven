import type { Diagnostic, DiagnosticSeverity } from "./types";

export function createDiagnostic(
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  path?: string,
  details?: Record<string, unknown>,
): Diagnostic {
  return { severity, code, message, path, details };
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
