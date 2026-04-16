import type { ExecutionSpec } from "../types";

const DYNAMIC_ARTIFACT_VERSION_TOKEN = "dynamic-artifact-version";
const DYNAMIC_ARTIFACT_VERSION_LITERAL_PATTERN = /(^|[^A-Za-z0-9_])dynamic-artifact-version(?=$|[^A-Za-z0-9_])/g;
const DYNAMIC_ARTIFACT_VERSION_FUNCTION_PATTERN =
  /\{\{\s*GetDynamicArtifactVersionOf\((['"`])([^'"`]+)\1\)\s*\}\}/g;

export function materializeDynamicVersionToken(
  value: string,
  artifactName: string,
  resolvedVersion: string,
): string {
  const withFunctionTemplates = value.replace(
    DYNAMIC_ARTIFACT_VERSION_FUNCTION_PATTERN,
    (match, _quote: string, tokenArtifactName: string) =>
      tokenArtifactName === artifactName ? resolvedVersion : match,
  );

  return withFunctionTemplates.replace(
    DYNAMIC_ARTIFACT_VERSION_LITERAL_PATTERN,
    (match, prefix: string) => `${prefix}${match.slice(prefix.length).replace(DYNAMIC_ARTIFACT_VERSION_TOKEN, resolvedVersion)}`,
  );
}

export function materializeDynamicVersionExecution(
  execution: ExecutionSpec,
  artifactName: string,
  resolvedVersion: string,
): ExecutionSpec {
  return {
    ...execution,
    args: execution.args.map((arg) =>
      materializeDynamicVersionToken(arg, artifactName, resolvedVersion),
    ),
    env: Object.fromEntries(
      Object.entries(execution.env).map(([key, value]) => [
        key,
        materializeDynamicVersionToken(value, artifactName, resolvedVersion),
      ]),
    ),
  };
}
