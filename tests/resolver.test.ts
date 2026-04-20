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

  assert.equal(plan.execution?.pluginPackage, "@envheaven/plugins-nodejs-pnpm");
  assert.equal(plan.execution?.command, "node");
  assert.deepEqual(plan.execution?.args, [
    "serve",
    path.resolve(repoRoot, "repos/local/envheaven-type-this-01"),
    "4101",
  ]);
  assert.equal(plan.execution?.cwd, path.resolve(repoRoot, "repos/local/envheaven-type-this-01"));
  assert.equal(plan.execution?.env.EH_ENV_MAP_NAME, "local-01");
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_PROFILE":"local"/);
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_SELF_PORT":"4101"/);
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_OTHER_PORT":"4102"/);
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_OTHER_ENV":"local-01"/);
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_BOOL_BASE":false/);
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_BOOL_LAYER":true/);
  assert.equal((plan.resolvedModel.Versioning as Record<string, unknown> | undefined)?.DefaultTrack, "exp");
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
  assert.equal(plan.execution?.pluginPackage, "@envheaven/plugins-nodejs-pnpm");
  assert.equal(plan.artifactExecutions.length, 3);
  const firebaseArtifact = plan.artifactExecutions.find(
    (artifactExecution) => artifactExecution.runnerName === "firebase-hosting-secondary",
  );
  assert.equal(firebaseArtifact?.execution?.pluginPackage, "@envheaven/plugins-firebase-hosting-deploy");
  assert.equal(firebaseArtifact?.execution?.args[1], "fake-local-01");
  assert.match(firebaseArtifact?.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_PROFILE":"fake-local"/);
});

test("materializes distributor DeployTarget from resolvedTarget template", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "fake-local", "deploy");

  assert.equal(plan.kind, "deploy");
  assert.equal(plan.requestedTarget, "fake-local");
  assert.equal(plan.resolvedTarget, "fake-local-01");
  assert.equal(plan.repoExecutions.length, 0);
  assert.equal(plan.artifactExecutions.filter((entry) => entry.status === "runnable").length, 2);

  const deployArtifact = plan.artifactExecutions.find(
    (entry) => entry.runnerName === "firebase-hosting-deploy",
  );
  assert.equal(deployArtifact?.execution?.pluginPackage, "@envheaven/plugins-firebase-hosting-deploy");
  assert.deepEqual(deployArtifact?.execution?.args, ["deploy", "fake-local-01"]);
  assert.match(deployArtifact?.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_PROFILE":"fake-local"/);

  const managedArtifact = plan.artifactExecutions.find(
    (entry) => entry.runnerName === "firebase-hosting-plugin-managed",
  );
  assert.equal(managedArtifact?.execution?.pluginPackage, "@envheaven/plugins-firebase-hosting-deploy");
  assert.equal(managedArtifact?.execution?.command, undefined);
  assert.equal(managedArtifact?.execution?.env.EH_DEPLOY_ENV, "layer-file-distributor");
});

test("materializes artifact templates using single quotes, double quotes, and backticks", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  assert.equal(plan.execution?.command, "node");
  assert.deepEqual(plan.execution?.args, [
    "serve",
    path.resolve(repoRoot, "repos/local/envheaven-type-this-01"),
    "4101",
  ]);
  assert.equal(plan.execution?.cwd, path.resolve(repoRoot, "repos/local/envheaven-type-this-01"));
  assert.equal(plan.execution?.env.EH_ENV_MAP_NAME, "local-01");
  assert.match(plan.execution?.env.EH_ENV_VARS_JSON ?? "", /"EH_PROFILE":"local"/);
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
  const nodePlugin = await loadPlugin("@envheaven/plugins-nodejs-pnpm", repoRoot);
  const firebasePlugin = await loadPlugin("@envheaven/plugins-firebase-hosting-deploy", repoRoot);

  assert.equal(nodePlugin.diagnostics.length, 0);
  assert.equal(firebasePlugin.diagnostics.length, 0);
  assert.ok(typeof nodePlugin.plugin.inspect === "function");
  assert.ok(typeof firebasePlugin.plugin.execute === "function");
});

test("falls back to global node_modules when plugin is not installed in repo", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-cycle");
  const previousGlobalRoot = process.env.ENVHEAVEN_GLOBAL_NODE_MODULES;
  process.env.ENVHEAVEN_GLOBAL_NODE_MODULES = path.join(fixturesRoot, "repo-basic", "node_modules");

  try {
    const plugin = await loadPlugin("@envheaven/plugins-nodejs-pnpm", repoRoot);
    assert.equal(plugin.diagnostics.length, 0);
    assert.ok(typeof plugin.plugin.inspect === "function");
  } finally {
    if (previousGlobalRoot === undefined) {
      delete process.env.ENVHEAVEN_GLOBAL_NODE_MODULES;
    } else {
      process.env.ENVHEAVEN_GLOBAL_NODE_MODULES = previousGlobalRoot;
    }
  }
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

test("materializes deploy local-01 with workspace steps and per-artifact local installs", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-deploy");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local-01", "deploy");

  assert.equal(plan.kind, "deploy");
  assert.equal(plan.requestedTarget, "local-01");
  assert.equal(plan.resolvedTarget, "local-01");
  assert.equal(plan.repoExecutions.length, 2);
  assert.deepEqual(plan.repoExecutions[0]?.execution?.args, ["install"]);
  assert.deepEqual(plan.repoExecutions[1]?.execution?.args, ["-r", "--if-present", "run", "build"]);
  assert.match(
    plan.repoExecutions[1]?.execution?.env.EH_OFFLINE_UI_ENV_JSON ?? "",
    /"EH_DEPLOY_MODE":"local-global-install"/,
  );
  assert.match(
    plan.repoExecutions[1]?.execution?.env.EH_OFFLINE_UI_ENV_JSON ?? "",
    /"EH_ARTIFACT_VERSION":"dynamic-artifact-version"/,
  );
  assert.equal(plan.artifactExecutions.filter((entry) => entry.status === "runnable").length, 3);
  assert.ok(
    plan.artifactExecutions.some(
      (entry) =>
        entry.runnerName === "envheaven-package-local-01" &&
        entry.execution?.args[0] === "install" &&
        entry.execution?.args[2] === path.resolve(repoRoot, "artifacts/envheaven-pkg-01"),
    ),
  );
  assert.ok(
    plan.artifactExecutions.some(
      (entry) =>
        entry.runnerName === "envheaven-plugin-offiline-web-ui-local-01" &&
        entry.execution?.args[2] === path.resolve(repoRoot, "artifacts/envheaven-pkg-plugin-offiline-web-ui-01"),
    ),
  );
});

test("materializes deploy production-01 with npm auth and scoped public publish", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-deploy");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "production-01", "deploy");

  assert.equal(plan.kind, "deploy");
  assert.equal(plan.repoExecutions.length, 3);
  assert.deepEqual(plan.repoExecutions[1]?.execution?.args, ["-r", "--if-present", "run", "build"]);
  assert.deepEqual(plan.repoExecutions[2]?.execution?.args, ["whoami"]);
  assert.ok(
    plan.artifactExecutions.some(
      (entry) =>
        entry.runnerName === "envheaven-plugin-nodejs-pnpm-production-01" &&
        entry.execution?.args.includes("--access") &&
        entry.execution?.args.includes("public"),
    ),
  );
  assert.ok(
    plan.artifactExecutions.some(
      (entry) =>
        entry.runnerName === "envheaven-plugin-offiline-web-ui-production-01" &&
        entry.execution?.args.includes("--access") &&
        entry.execution?.cwd === path.resolve(repoRoot, "artifacts/envheaven-pkg-plugin-offiline-web-ui-01"),
    ),
  );
});
