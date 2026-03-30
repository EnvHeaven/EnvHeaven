import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discoverEnvRepo } from "../src/envrepo/discovery";
import { buildRepoModel } from "../src/envrepo/model";
import { resolvePlan } from "../src/envrepo/resolver";
import { loadPlugin } from "../src/plugins/loader";

const fixturesRoot = path.join(__dirname, "fixtures");

test("separates env layer resolution from artifact runner materialization", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  assert.equal(plan.requestedTarget, "local");
  assert.equal(plan.resolvedTarget, "local-01");
  assert.deepEqual(plan.targetResolutionTrace, ["local", "local-01"]);
  assert.deepEqual(plan.mergeOrder, ["default", "local-01"]);
  assert.equal(typeof plan.resolvedModel.Artifacts, "object");
  assert.ok(!("Execution" in plan.resolvedModel));
  assert.ok(!("RunCommand" in plan.resolvedModel));
});

test("materializes local-01 artifact execution plans through ArtifactsRunners", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  assert.equal(plan.execution?.pluginPackage, "@envheaven/plugin-nodejs-pnpm");
  assert.equal(plan.execution?.command, "node");
  assert.deepEqual(plan.execution?.args, [
    "serve",
    path.resolve(repoRoot, "repos/local/envheaven-type-this-01"),
    "4101",
  ]);
  assert.equal(plan.execution?.cwd, path.resolve(repoRoot, "repos/local/envheaven-type-this-01"));
  assert.equal(plan.execution?.env.EH_ENV_MAP_NAME, "local-01");
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_PROFILE":"local"/);
  assert.ok(plan.artifactExecutions.some((artifactExecution) => artifactExecution.status === "runnable"));
  assert.ok(plan.artifactExecutions.some((artifactExecution) => artifactExecution.status === "partial"));
});

test("materializes fake-local-01 artifact execution plans through ArtifactsRunners", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "fake-local");

  assert.equal(plan.requestedTarget, "fake-local");
  assert.equal(plan.resolvedTarget, "fake-local-01");
  assert.equal(plan.execution?.pluginPackage, "@envheaven/plugin-nodejs-pnpm");
  assert.equal(plan.artifactExecutions.length, 3);
  const firebaseArtifact = plan.artifactExecutions.find(
    (artifactExecution) => artifactExecution.runnerName === "firebase-hosting-secondary",
  );
  assert.equal(firebaseArtifact?.execution?.pluginPackage, "@envheaven/plugin-firebase-hosting-deploy");
  assert.equal(firebaseArtifact?.execution?.args[1], "fake-local-01");
  assert.match(firebaseArtifact?.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_PROFILE":"fake-local"/);
});

test("rejects unsupported conditions after TargetName dereferencing", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-malformed-target");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "fake-local-01");

  assert.equal(plan.execution, null);
  assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.code === "unsupported-condition-type"));
});

test("loads renamed scoped plugins from local fixture metadata", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const nodePlugin = await loadPlugin("@envheaven/plugin-nodejs-pnpm", repoRoot);
  const firebasePlugin = await loadPlugin("@envheaven/plugin-firebase-hosting-deploy", repoRoot);

  assert.equal(nodePlugin.diagnostics.length, 0);
  assert.equal(firebasePlugin.diagnostics.length, 0);
  assert.ok(typeof nodePlugin.plugin.inspect === "function");
  assert.ok(typeof firebasePlugin.plugin.execute === "function");
});

test("rejects legacy invalid scoped plugin package names", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const plugin = await loadPlugin("@envheaven/plugins/nodejs-pnpm", repoRoot);

  assert.ok(plugin.diagnostics.some((diagnostic) => diagnostic.code === "plugin-package-name-invalid"));
});

test("detects TargetName cycles", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-cycle");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  assert.equal(plan.execution, null);
  assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.code === "target-cycle"));
});

test("keeps the plan partially runnable when one artifact runner is invalid", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  const brokenArtifact = plan.artifactExecutions.find(
    (artifactExecution) => artifactExecution.runnerName === "broken-runner",
  );
  assert.equal(brokenArtifact?.status, "partial");
  assert.equal(brokenArtifact?.execution, null);
  assert.ok(brokenArtifact?.diagnostics.some((diagnostic) => diagnostic.code === "artifact-missing"));
  assert.equal(plan.execution?.command, "node");
  assert.equal(
    plan.diagnostics.some((diagnostic) => diagnostic.code === "execution-missing"),
    false,
  );
});

test("does not emit top-level execution-missing when the target layer itself has no Execution", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  assert.ok(plan.execution);
  assert.equal(
    plan.diagnostics.some((diagnostic) => diagnostic.code === "execution-missing"),
    false,
  );
});
