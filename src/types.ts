export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface CommandIntent {
  kind: "daemon" | "run" | "deploy";
  target?: SupportedTarget;
  rawArgs: string[];
  normalizedTokens: string[];
}

export type SupportedTarget =
  | "default"
  | "local"
  | "local-01"
  | "production-01"
  | "fake-local"
  | "fake-local-01";

export interface EnvRepoFile {
  sourcePath: string;
  relativePath: string;
  fileName: string;
  payload: Record<string, unknown> | null;
  diagnostics: Diagnostic[];
}

export interface RepoDiscoveryResult {
  rootDirectory: string;
  envDirectories: string[];
  files: EnvRepoFile[];
  diagnostics: Diagnostic[];
}

export interface MergeTraceEntry {
  source: string;
  layerName: string;
  propertyPath: string;
  action: "set" | "override" | "merge" | "replace-array";
}

export interface ExecutionSpec {
  pluginPackage?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  raw?: Record<string, unknown>;
}

export interface ArtifactExecutionPlan {
  artifactName: string;
  runnerName: string;
  status: "runnable" | "partial" | "blocked";
  diagnostics: Diagnostic[];
  trace: string[];
  execution: ExecutionSpec | null;
}

export interface RepoExecutionPlan {
  name: string;
  status: "runnable" | "partial" | "blocked";
  diagnostics: Diagnostic[];
  trace: string[];
  execution: ExecutionSpec | null;
}

export interface ResolvedPlan {
  kind: "run" | "deploy";
  requestedTarget: SupportedTarget;
  resolvedTarget: string;
  targetResolutionTrace: string[];
  mergeOrder: string[];
  diagnostics: Diagnostic[];
  trace: MergeTraceEntry[];
  repoExecutions: RepoExecutionPlan[];
  artifactExecutions: ArtifactExecutionPlan[];
  execution: ExecutionSpec | null;
  pluginPackage?: string;
  resolvedModel: Record<string, unknown>;
}

export interface PluginInspectResult {
  diagnostics?: Diagnostic[];
  details?: Record<string, unknown>;
}

export interface PluginExecuteResult {
  diagnostics?: Diagnostic[];
  exitCode: number;
  details?: Record<string, unknown>;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface SpawnResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export interface PluginRuntimeContext {
  repoRoot: string;
  platform: NodeJS.Platform;
  diagnostics: Diagnostic[];
  spawnExecution(request: SpawnRequest): Promise<SpawnResult>;
}

export interface EnvHeavenPlugin {
  inspect?(context: PluginRuntimeContext): Promise<PluginInspectResult> | PluginInspectResult;
  execute?(plan: ResolvedPlan, context: PluginRuntimeContext): Promise<PluginExecuteResult> | PluginExecuteResult;
}

export interface LoadedPlugin {
  packageName: string;
  resolvedPath: string;
  plugin: EnvHeavenPlugin;
  diagnostics: Diagnostic[];
}

export interface NormalizedLayer {
  sourcePath: string;
  fileName: string;
  envMapLayers: Record<string, Record<string, unknown>>;
  aliases: Record<string, string[]>;
  fallbackList: string[];
}

export interface RepoModel {
  rootDirectory: string;
  layers: NormalizedLayer[];
  envMapLayers: Record<string, Record<string, unknown>>;
  artifacts: Record<string, Record<string, unknown>>;
  artifactsRunners: Record<string, Record<string, unknown>>;
  artifactsDistributors: Record<string, Record<string, unknown>>;
  repoDeployExecutions: Record<string, Record<string, unknown>[]>;
  aliases: Record<string, string[]>;
  fallbackList: string[];
  diagnostics: Diagnostic[];
  discovery: RepoDiscoveryResult;
}
