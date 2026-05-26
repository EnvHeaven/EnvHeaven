<p align="center">
  <a href="https://envheaven.com">
    <img src="./docs/readme/logo/envheaven-logo.svg" alt="EnvHeaven" width="96" />
  </a>
</p>

# EnvHeaven

> Experimental environment orchestration for local, deploy, and plugin-driven workflows.

[![npm version](https://img.shields.io/npm/v/envheaven)](https://www.npmjs.com/package/envheaven)
[![node](https://img.shields.io/node/v/envheaven)](https://www.npmjs.com/package/envheaven)
[![npm downloads](https://img.shields.io/npm/dm/envheaven)](https://www.npmjs.com/package/envheaven)
[![license](https://img.shields.io/npm/l/envheaven)](https://www.npmjs.com/package/envheaven)

> **Experimental 0.x:** EnvHeaven is currently in experimental `0.x` development. APIs, CLI commands, plugin contracts, package names, and release behavior may change before `1.0.0`. Pin versions and read release notes before using it in production workflows.

## Why

EnvHeaven is for projects where environment-specific commands, deploy targets, package versions, and local tooling need to be discoverable and repeatable instead of living only in shell history or personal notes.

It discovers `.envheaven` repositories, resolves environment maps, and lets plugins inspect or execute environment-aware actions.

## What it does

- Discovers `.envheaven` metadata from a repository tree.
- Resolves environment targets such as `local-01`, `development-01`, `beta-01`, and `production-01`.
- Runs plugin-backed `inspect` and `execute` flows for local and deploy commands.
- Provides a local daemon API for repos, actions, versions, terminal sessions, and Action Board presets.
- Tracks local artifact versions and supports dynamic artifact version tokens during publish flows.
- Supports interactive PTY action terminals through the offline UI.

## Quick start

```sh
# release track
npm install -g envheaven@release

# npm default alias for the release track
npm install -g envheaven

# experimental track
npm install -g envheaven@exp

# check the CLI
envheaven --help

# use the short alias
eh --help

# start the local daemon
envheaven
```

The Offline Web UI is prepared under the corrected `@envheaven/plugins-offline-web-ui` package name. The legacy typo package `@envheaven/plugins-offiline-web-ui` remains a migration concern only.

## Minimal `.envheaven` shape

EnvHeaven reads env-map layer files under `.envheaven/`, including files like:

```txt
.envheaven/
  safe-env-map-layers/
  secret-env-map-layers/
```

A typical layer can define artifacts and deploy executions:

```jsonc
{
  "Artifacts": {
    "web-site-01-fe-01": {
      "RepoCloneFolderPath": "./artifacts/web-site-01-fe-01",
      "PackageName": "web-site-01-fe-01"
    }
  },
  "RepoDeployExecutions": {
    "local-01": [
      {
        "Name": "workspace-build",
        "Execution": {
          "command": "pnpm",
          "args": ["run", "build"],
          "cwd": "."
        }
      }
    ]
  }
}
```

## Packages

| Package | Status | Purpose |
|---|---|---|
| `envheaven` | published | CLI, daemon, plugin host, environment resolution |
| `@envheaven/plugins-nodejs-pnpm` | published | Run pnpm scripts and pnpm exec specs through EnvHeaven |
| `@envheaven/plugins-firebase-hosting-deploy` | published | Deploy Firebase Hosting targets through EnvHeaven |
| `@envheaven/plugins-offline-web-ui` | prepared for publication / NPM not verified | Local offline UI for daemon, actions, state, versions, and Action Board |
| `@envheaven/plugins-aws-s3-cdn-deploy` | prepared for publication / NPM not verified | Append-only AWS S3 CDN deploy plugin |

## Plugin contract

Plugins are loaded by package name and may expose:

```ts
inspect?(context): Promise<PluginInspectResult> | PluginInspectResult;
execute?(plan, context): Promise<PluginExecuteResult> | PluginExecuteResult;
```

The host provides repository context, diagnostics, and a process execution helper.

## Release channels

Planned public package channels:

| Channel | Install | Purpose |
|---|---|---|
| `release` | `npm install -g envheaven@release` | intended main `0.x` release track |
| `latest` | `npm install -g envheaven` | npm default alias for the current release track |
| `exp` | `npm install -g envheaven@exp` | experimental builds with newer changes |

Registry verification currently confirms `latest` and `exp`. The `release` tag is a publish target for the next release flow. Local version registry tracks may include `canary`, `alpha`, `beta`, `rc`, and `release`, but `canary`, `alpha`, `beta`, and `rc` were not verified as public NPM dist-tags.

## Current status

EnvHeaven is usable for early CLI, daemon, plugin, local version registry, and package deploy workflows. Public documentation and package metadata are still being consolidated.

Do not treat the `0.x` API, command set, or plugin contract as stable.

## Contributing

Use Node.js `>=20`. Build and test from the package root:

```sh
pnpm install
pnpm run build
pnpm test
```

## License

MIT, as declared in `package.json`.
