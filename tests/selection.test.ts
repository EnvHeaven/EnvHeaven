import test from "node:test";
import assert from "node:assert/strict";
import { resolveArtifactSelection } from "../src/deploy/selection";
import type { ArtifactExecutionPlan } from "../src/types";

const artifactExecutions: ArtifactExecutionPlan[] = [
  {
    artifactName: "envheaven-package-01",
    packageName: "envheaven",
    repoCloneFolderPath: "./artifacts/envheaven-pkg-01",
    deployTarget: "local-01",
    runnerName: "envheaven-package-local-01",
    status: "runnable",
    diagnostics: [],
    trace: [],
    execution: null,
  },
  {
    artifactName: "envheaven-plugin-nodejs-pnpm-01",
    packageName: "@envheaven/plugins-nodejs-pnpm",
    repoCloneFolderPath: "./artifacts/envheaven-pkg-plugin-nodejs-pnpm-01",
    deployTarget: "local-01",
    runnerName: "envheaven-plugin-nodejs-pnpm-local-01",
    status: "runnable",
    diagnostics: [],
    trace: [],
    execution: null,
  },
];

test("selects artifacts by exact package name and common alias", () => {
  const packageNameSelection = resolveArtifactSelection(artifactExecutions, ["@envheaven/plugins-nodejs-pnpm"]);
  const aliasSelection = resolveArtifactSelection(artifactExecutions, ["plugins-nodejs-pnpm"]);

  assert.deepEqual(packageNameSelection.artifactNames, ["envheaven-plugin-nodejs-pnpm-01"]);
  assert.deepEqual(aliasSelection.artifactNames, ["envheaven-plugin-nodejs-pnpm-01"]);
  assert.equal(packageNameSelection.diagnostics.length, 0);
});

test("returns all artifacts when no selectors are provided", () => {
  const selection = resolveArtifactSelection(artifactExecutions, []);
  assert.deepEqual(selection.artifactNames, [
    "envheaven-package-01",
    "envheaven-plugin-nodejs-pnpm-01",
  ]);
});

test("reports missing selectors clearly", () => {
  const selection = resolveArtifactSelection(artifactExecutions, ["missing-artifact"]);
  assert.equal(selection.artifactNames.length, 0);
  assert.ok(selection.diagnostics.some((diagnostic) => diagnostic.code === "artifact-selector-not-found"));
});
