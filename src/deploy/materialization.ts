import { promises as fs } from "node:fs";
import path from "node:path";
import { createDiagnostic } from "../diagnostics";
import type { Diagnostic } from "../types";

export interface BuildContext {
  version: string;
  target: string;
  envMapName: string;
  variables: Record<string, string>;
  timestamp: string;
  artifactName: string;
}

export interface MaterializationResult {
  contextFilePath: string;
  diagnostics: Diagnostic[];
}

const BUILD_CONTEXT_FILENAME = ".envheaven-build-context.json";

export function resolveBuildVersion(
  storeNextVersion: string | null | undefined,
  storeLastVersion: string | null | undefined,
  packageJsonVersion: string,
): string {
  if (storeNextVersion && storeNextVersion.length > 0) {
    return storeNextVersion;
  }

  if (storeLastVersion && storeLastVersion.length > 0) {
    return storeLastVersion;
  }

  return packageJsonVersion;
}

export function resolveVariables(
  envVars: Record<string, string>,
  resolvedTarget: string,
  resolvedVersion: string,
  extraOverrides?: Record<string, string>,
): Record<string, string> {
  const variables: Record<string, string> = {
    ...envVars,
    EH_DEPLOY_TARGET: resolvedTarget,
    EH_ARTIFACT_VERSION: resolvedVersion,
    EH_BUILD_TIMESTAMP: new Date().toISOString(),
  };

  if (extraOverrides) {
    Object.assign(variables, extraOverrides);
  }

  return variables;
}

export function buildBuildContext(
  artifactName: string,
  resolvedTarget: string,
  envMapName: string,
  resolvedVersion: string,
  envVars: Record<string, string>,
): BuildContext {
  return {
    version: resolvedVersion,
    target: resolvedTarget,
    envMapName,
    variables: resolveVariables(envVars, resolvedTarget, resolvedVersion),
    timestamp: new Date().toISOString(),
    artifactName,
  };
}

export async function materializeBuildContext(
  outputDirectory: string,
  context: BuildContext,
): Promise<MaterializationResult> {
  const diagnostics: Diagnostic[] = [];
  const contextFilePath = path.join(outputDirectory, BUILD_CONTEXT_FILENAME);

  try {
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(
      contextFilePath,
      `${JSON.stringify(context, null, 2)}\n`,
      "utf8",
    );
    diagnostics.push(
      createDiagnostic(
        "info",
        "build-context-materialized",
        `Build context written to "${contextFilePath}".`,
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push(
      createDiagnostic(
        "error",
        "build-context-write-failed",
        `Failed to write build context: ${msg}`,
      ),
    );
  }

  return { contextFilePath, diagnostics };
}

export async function readBuildContext(
  directory: string,
): Promise<BuildContext | null> {
  const contextFilePath = path.join(directory, BUILD_CONTEXT_FILENAME);
  try {
    const raw = await fs.readFile(contextFilePath, "utf8");
    return JSON.parse(raw) as BuildContext;
  } catch {
    return null;
  }
}

export async function cleanBuildContext(
  directory: string,
): Promise<Diagnostic[]> {
  const contextFilePath = path.join(directory, BUILD_CONTEXT_FILENAME);
  try {
    await fs.unlink(contextFilePath);
    return [
      createDiagnostic(
        "info",
        "build-context-cleaned",
        `Build context removed from "${contextFilePath}".`,
      ),
    ];
  } catch {
    return [];
  }
}
