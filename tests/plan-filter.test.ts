import test from "node:test";
import assert from "node:assert/strict";
import { applyPnpmRecursiveFilter, isLocalGlobalInstall } from "../src/deploy/plan-filter";
import type { ArtifactExecutionPlan, ExecutionSpec } from "../src/types";

function makeExec(args: string[]): ExecutionSpec {
  return { command: "pnpm", args, env: {}, cwd: "/repo" };
}

function makeArtifact(artifactName: string, packageName?: string): ArtifactExecutionPlan {
  return {
    artifactName,
    packageName,
    runnerName: `${artifactName}-runner`,
    status: "runnable",
    diagnostics: [],
    trace: [],
    execution: null,
  };
}

test("applyPnpmRecursiveFilter: no-op when selectedArtifacts is empty (deploy all)", () => {
  const exec = makeExec(["-r", "--if-present", "run", "build"]);
  const artifacts = [makeArtifact("envheaven-package-01", "envheaven")];
  const result = applyPnpmRecursiveFilter(exec, artifacts, []);
  assert.deepEqual(result?.args, ["-r", "--if-present", "run", "build"]);
});

test("applyPnpmRecursiveFilter: no-op when execution is null", () => {
  const result = applyPnpmRecursiveFilter(null, [], ["envheaven"]);
  assert.equal(result, null);
});

test("applyPnpmRecursiveFilter: no-op when command is not pnpm", () => {
  const exec: ExecutionSpec = { command: "npm", args: ["-r", "run", "build"], env: {}, cwd: "/repo" };
  const result = applyPnpmRecursiveFilter(exec, [makeArtifact("a", "pkg-a")], ["a"]);
  assert.deepEqual(result?.args, ["-r", "run", "build"]);
});

test("applyPnpmRecursiveFilter: no-op when -r flag is absent", () => {
  const exec = makeExec(["install"]);
  const result = applyPnpmRecursiveFilter(exec, [makeArtifact("a", "pkg-a")], ["a"]);
  assert.deepEqual(result?.args, ["install"]);
});

test("applyPnpmRecursiveFilter: no-op when no artifact has a packageName", () => {
  const exec = makeExec(["-r", "--if-present", "run", "build"]);
  const artifacts = [makeArtifact("envheaven-package-01")];
  const result = applyPnpmRecursiveFilter(exec, artifacts, ["envheaven"]);
  assert.deepEqual(result?.args, ["-r", "--if-present", "run", "build"]);
});

test("applyPnpmRecursiveFilter: replaces -r with --filter when one artifact selected", () => {
  const exec = makeExec(["-r", "--if-present", "run", "build"]);
  const artifacts = [makeArtifact("envheaven-package-01", "envheaven")];
  const result = applyPnpmRecursiveFilter(exec, artifacts, ["envheaven"]);
  assert.deepEqual(result?.args, ["--filter", "envheaven", "--if-present", "run", "build"]);
});

test("applyPnpmRecursiveFilter: injects multiple --filter flags for multiple selected artifacts", () => {
  const exec = makeExec(["-r", "--if-present", "run", "build"]);
  const artifacts = [
    makeArtifact("envheaven-package-01", "envheaven"),
    makeArtifact("envheaven-plugin-nodejs-pnpm-01", "@envheaven/plugins-nodejs-pnpm"),
  ];
  const result = applyPnpmRecursiveFilter(exec, artifacts, ["envheaven", "envheaven-plugin-nodejs-pnpm-01"]);
  assert.deepEqual(result?.args, [
    "--filter", "envheaven",
    "--filter", "@envheaven/plugins-nodejs-pnpm",
    "--if-present", "run", "build",
  ]);
});

test("applyPnpmRecursiveFilter: -r at non-zero position is correctly replaced", () => {
  const exec = makeExec(["--if-present", "-r", "run", "build"]);
  const artifacts = [makeArtifact("envheaven-package-01", "envheaven")];
  const result = applyPnpmRecursiveFilter(exec, artifacts, ["envheaven"]);
  assert.deepEqual(result?.args, ["--if-present", "--filter", "envheaven", "run", "build"]);
});

test("applyPnpmRecursiveFilter: preserves all other ExecutionSpec fields unchanged", () => {
  const exec: ExecutionSpec = { command: "pnpm", args: ["-r", "run", "build"], env: { EH_TARGET: "local-01" }, cwd: "/repo" };
  const artifacts = [makeArtifact("envheaven-package-01", "envheaven")];
  const result = applyPnpmRecursiveFilter(exec, artifacts, ["envheaven"]);
  assert.equal(result?.command, "pnpm");
  assert.equal(result?.cwd, "/repo");
  assert.deepEqual(result?.env, { EH_TARGET: "local-01" });
});

test("isLocalGlobalInstall: true for pnpm add --global <path>", () => {
  assert.equal(isLocalGlobalInstall("pnpm", ["add", "--global", "./artifacts/envheaven-pkg-01"]), true);
});

test("isLocalGlobalInstall: false for npm publish", () => {
  assert.equal(isLocalGlobalInstall("npm", ["publish"]), false);
});

test("isLocalGlobalInstall: false for pnpm install (workspace install)", () => {
  assert.equal(isLocalGlobalInstall("pnpm", ["install"]), false);
});

test("isLocalGlobalInstall: false for pnpm add without --global", () => {
  assert.equal(isLocalGlobalInstall("pnpm", ["add", "lodash"]), false);
});

test("isLocalGlobalInstall: false when command is undefined", () => {
  assert.equal(isLocalGlobalInstall(undefined, ["add", "--global", "pkg"]), false);
});
