import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discoverEnvRepo } from "../src/envrepo/discovery";
import { buildRepoModel } from "../src/envrepo/model";
import { resolvePlan } from "../src/envrepo/resolver";
import { loadPlugin } from "../src/plugins/loader";

const fixturesRoot = path.join(__dirname, "fixtures");

test("builds a deterministic merge order with optional missing fallbacks", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  assert.equal(plan.requestedTarget, "local");
  assert.equal(plan.resolvedTarget, "local-01");
  assert.deepEqual(plan.targetResolutionTrace, ["local", "local-01"]);
  assert.deepEqual(plan.mergeOrder, ["default", "local-01"]);
  assert.equal(plan.execution?.pluginPackage, "@envheaven/plugins-nodejs-pnpm");
  assert.equal(plan.execution?.args[0], "local-01-script");
  assert.ok(plan.trace.some((entry) => entry.propertyPath === "Execution.args"));
  assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.code === "optional-layer-missing"));
});

test("resolves fake-local through TargetName to a concrete execution plan", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "fake-local");

  assert.equal(plan.requestedTarget, "fake-local");
  assert.equal(plan.resolvedTarget, "fake-local-01");
  assert.deepEqual(plan.targetResolutionTrace, ["fake-local", "fake-local-01"]);
  assert.equal(plan.execution?.pluginPackage, "@envheaven/plugins-firebase-hosting-deploy");
  assert.equal(plan.execution?.command, "node");
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

test("produces a non-null execution plan for envheaven run local when concrete layer exists", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "local");

  assert.ok(plan.execution);
  assert.equal(plan.execution?.command, "node");
});
