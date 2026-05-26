<br />

<p align="center">
  <a href="https://envheaven.com">
    <img src="./docs/readme/logo/envheaven-logo.svg" alt="EnvHeaven" width="96" />
  </a>

  <h1 align="center">EnvHeaven</h1>

  <p align="center">
    Environment hell, inverted.
  </p>

  <p align="center">
    <a href="#quick-start">Quick Start</a>
    ·
    <a href="#packages">Packages</a>
    ·
    <a href="#release-channels">Release Channels</a>
  </p>
</p>

<div align="center">

[![npm](https://img.shields.io/npm/v/envheaven)](https://www.npmjs.com/package/envheaven)
[![downloads](https://img.shields.io/npm/dm/envheaven)](https://www.npmjs.com/package/envheaven)
[![license](https://img.shields.io/npm/l/envheaven)](#license)
[![node](https://img.shields.io/node/v/envheaven)](https://www.npmjs.com/package/envheaven)
[![status](https://img.shields.io/badge/status-experimental%200.x-orange)](#experimental-0x)

</div>

> **Experimental 0.x:** EnvHeaven is currently in experimental `0.x` development. APIs, CLI commands, plugin contracts, package names, and release behavior may change before `1.0.0`. Pin versions and read release notes before using it in production workflows.

## Quick Start

```sh
npm install -g envheaven@release
npm install -g envheaven
npm install -g envheaven@exp

envheaven --help
eh --help
```

## What it does

- Discovers `.envheaven` metadata from repository trees.
- Resolves environment targets and artifact metadata.
- Runs plugin-backed inspect and execute flows.
- Provides local daemon APIs for repos, actions, versions, terminal sessions, and presets.
- Supports interactive PTY terminals through the Offline Web UI package.

## Packages

| Package | Registry status | Purpose |
|---|---|---|
| `envheaven` | published | CLI, daemon, plugin host, environment resolution |
| `@envheaven/plugins-nodejs-pnpm` | published | pnpm-backed Node.js workflow plugin |
| `@envheaven/plugins-firebase-hosting-deploy` | published | Firebase Hosting deploy plugin |
| `@envheaven/plugins-offline-web-ui` | prepared; not verified on NPM | local Offline Web UI package |
| `@envheaven/plugins-aws-s3-cdn-deploy` | prepared; not verified on NPM | append-only AWS S3 CDN deploy plugin |

## Release Channels

| Channel | Install | Purpose |
|---|---|---|
| `release` | `npm install -g envheaven@release` | recommended 0.x release track |
| `latest` | `npm install -g envheaven` | npm default alias for the release track |
| `exp` | `npm install -g envheaven@exp` | experimental builds with newer changes |

`release` is the recommended 0.x track, not a stable API promise.

## Status

EnvHeaven is useful for early CLI, daemon, local package deploy, and plugin workflows. Public docs and package metadata are still being consolidated.

## License

MIT, as declared in `package.json`.
