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
  - `eh run local`
  - `eh default`

## Not Implemented in v0.1.0

- `deploy`
- `last`
- `development`
- marketplace or plugin auto-install
- env-map rewrites beyond `RunCommand` to `Execution` normalization for planning/execution

## Installation

```bash
npm install -g envheaven
```

## CLI Behavior

Running `envheaven` or `eh` without arguments starts a minimal local daemon and prints its port as JSON.

Running a supported `run` intent resolves the repo, loads the plugin declared in the resolved execution, calls `inspect()` when provided, then calls `execute()` when there are no blocking diagnostics. The CLI prints a JSON payload containing parsed intent, resolved plan, plugin details, execution result, and severity-tagged diagnostics.

## Minimal Env-Repo Shape

`envheaven` keeps the accepted schema intentionally small. v0.1.0 reads these top-level properties when present:

- `EnvMapLayers`
- `aliases` or `Aliases`
- `fallback-list`, `fallbackList`, or `FallbackList`

Each resolved target should expose `Execution` or `RunCommand`. `RunCommand` is normalized into `Execution` only for planning/execution.

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

Rejected command:

```json
{
  "diagnostics": [
    {
      "severity": "error",
      "code": "unsupported-command",
      "message": "Unsupported token \"deploy\" in v0.1.0."
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

- Windows execution is delegated through `wsl` in v0.1.0.
- The resolver is intentionally conservative and only understands a small subset of the env-map model.
- Unsupported condition types are hard errors.
- Missing optional fallback layers are reported as info-level diagnostics and do not stop the repo from loading.
- The daemon is inspection-only and does not execute plans.
