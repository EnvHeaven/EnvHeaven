"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDiagnostic = createDiagnostic;
exports.hasErrors = hasErrors;
function createDiagnostic(severity, code, message, path, details) {
    return { severity, code, message, path, details };
}
function hasErrors(diagnostics) {
    return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
