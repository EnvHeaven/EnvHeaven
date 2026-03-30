# envheaven

`envheaven@0.1.0` is a narrow npm CLI for discovering `.envheaven` env-repo files, resolving a small supported target set, exposing a minimal HTTP daemon, and delegating inspection/execution to plugins loaded by package name.

## v0.1.0 Scope

- Discover `.envheaven/` directories recursively from the current working directory.
- Load files ending with `.envheaven.env-map-layer.json`.
- Parse those files as JSONC-like input with comments and trailing commas.
- Build an in-memory env-repo model from `repo-base.default.envheaven.env-map-layer.json` plus additional layer files.
- Resolve `EnvMapLayers`, `fallback-list`, aliases, and deterministic merge order for supported targets.
- Support only `Condition.Type` values `always-force` and `only-if-full-setup-completion`.
- Support only these command intents:
  - `envheaven`
  - `eh`
  - `envheaven run default`
  - `envheaven default`
  - `envheaven run local`
  - `envheaven local run`
  - `envheaven run local-01`
  - `envheaven run fake local`
  - `envheaven run fake local-01`
  - `envheaven run fake-local-01`
  - `envheaven deploy local`
  - `envheaven deploy local-01`
  - `envheaven deploy production`
  - `envheaven deploy production-01`
  - `eh run local`
  - `eh default`

## Not Implemented in v0.1.0

- `last`
- `development`
- marketplace or plugin auto-install
- deploy support beyond the current package-monorepo use case
- env-map rewrites beyond the current normalization and materialization behavior

## Installation

```bash
npm install -g envheaven
```

## CLI Behavior

Running `envheaven` or `eh` without arguments starts a minimal local daemon and prints its port as JSON.

Running a supported `run` intent resolves the repo, loads the plugin declared in the resolved execution, calls `inspect()` when provided, then calls `execute()` when there are no blocking diagnostics.

Running a supported `deploy` intent materializes repo-level deploy steps and per-artifact distributor executions, then executes them sequentially. The current deploy support is intentionally narrow and targets EnvHeaven-style package monorepos that define `RepoDeployExecutions` and `ArtifactsDistributors`.

On Windows, direct `pnpm` and `npm` deploy steps run natively in the Windows host environment for the package-monorepo workflow. Other commands still follow the existing WSL delegation path in v0.1.0.

The CLI prints a JSON payload containing parsed intent, resolved plan, execution details, and severity-tagged diagnostics.

## Minimal Env-Repo Shape

`envheaven` keeps the accepted schema intentionally small. v0.1.0 reads these top-level properties when present:

- `EnvMapLayers`
- `aliases` or `Aliases`
- `fallback-list`, `fallbackList`, or `FallbackList`

Run-oriented env layers may remain execution-free. v0.1.0 can now:

- materialize `run` plans from `ArtifactsRunners`
- materialize `deploy` plans from `RepoDeployExecutions` and `ArtifactsDistributors`

`Type: "fallback-list"` layers may point at another layer through `TargetName`. v0.1.0 now dereferences that chain recursively before merge resolution and reports `requestedTarget`, `resolvedTarget`, `targetResolutionTrace`, `mergeOrder`, and `trace` in the resolved plan.

```jsonc
{
  "fallback-list": ["local-user-overrides-01"],
  "EnvMapLayers": {
    "default": {
      "Execution": {
        "pluginPackage": "@envheaven/plugins-nodejs-pnpm",
        "command": "node",
        "args": ["script.js"],
        "env": {
          "EH_TARGET": "default"
        },
        "cwd": "."
      }
    },
    "local": {
      "Type": "fallback-list",
      "TargetName": "local-01"
    },
    "local-01": {
      "fallback-list": ["default"],
      "Execution": {
        "pluginPackage": "@envheaven/plugins-nodejs-pnpm",
        "args": ["local-script.js"]
      }
    }
  }
}
```

## Plugin Contract

Plugins are loaded by package name through normal Node module resolution from the inspected env-repo root. A plugin should export `inspect(context)` and/or `execute(plan, context)`.

Known valid package names in the v0.1.0 examples:

- `@envheaven/plugins-nodejs-pnpm`
- `@envheaven/plugins-firebase-hosting-deploy`

```ts
import type {
  EnvHeavenPlugin,
  PluginExecuteResult,
  PluginInspectResult,
  PluginRuntimeContext,
  ResolvedPlan,
} from "envheaven";

export const plugin: EnvHeavenPlugin = {
  inspect(context: PluginRuntimeContext): PluginInspectResult {
    return {
      details: {
        repoRoot: context.repoRoot
      }
    };
  },
  async execute(plan: ResolvedPlan, context: PluginRuntimeContext): Promise<PluginExecuteResult> {
    const result = await context.spawnExecution({
      command: plan.execution?.command ?? "node",
      args: plan.execution?.args ?? [],
      env: plan.execution?.env ?? {},
      cwd: plan.execution?.cwd
    });

    return {
      exitCode: result.exitCode,
      details: {
        signal: result.signal,
        requestedTarget: plan.requestedTarget,
        resolvedTarget: plan.resolvedTarget
      }
    };
  }
};
```

## Daemon Endpoints

The daemon uses Node's built-in `http` module and exposes read-only JSON endpoints:

- `GET /repo/discovery`
- `GET /plugin/status`
- `GET /plans/default`
- `GET /plans/local`
- `GET /plans/local-01`
- `GET /plans/fake-local`
- `GET /plans/fake-local-01`

## Example Output

`envheaven run local`

```json
{
  "intent": {
    "kind": "run",
    "target": "local"
  },
  "plan": {
    "requestedTarget": "local",
    "resolvedTarget": "local-01",
    "targetResolutionTrace": ["local", "local-01"],
    "mergeOrder": ["default", "local-01"]
  },
  "execution": {
    "exitCode": 0
  },
  "diagnostics": [
    {
      "severity": "info",
      "code": "optional-layer-missing"
    }
  ]
}
```

Deploy example:

```json
{
  "intent": {
    "kind": "deploy",
    "target": "local-01"
  },
  "plan": {
    "kind": "deploy",
    "requestedTarget": "local-01",
    "resolvedTarget": "local-01"
  },
  "deploy": {
    "repoExecutions": [
      {
        "name": "workspace-install"
      }
    ],
    "artifactExecutions": [
      {
        "runnerName": "envheaven-package-local-01"
      }
    ]
  }
}
```

Rejected command:

```json
{
  "diagnostics": [
    {
      "severity": "error",
      "code": "unsupported-command-shape",
      "message": "Unsupported or ambiguous deploy target: \"default\"."
    }
  ]
}
```

Daemon startup:

```json
{
  "mode": "daemon",
  "port": 43123,
  "diagnostics": [
    {
      "severity": "info",
      "code": "daemon-started",
      "message": "EnvHeaven daemon started on port 43123."
    }
  ]
}
```

## Limitations

- Windows deploy steps that invoke `pnpm` or `npm` are executed natively, while other commands still use the existing `wsl` delegation path in v0.1.0.
- The resolver is intentionally conservative and only understands a small subset of the env-map model.
- Unsupported condition types are hard errors.
- Missing optional fallback layers are reported as info-level diagnostics and do not stop the repo from loading.
- The daemon landing page is minimal and the daemon does not execute plans.
