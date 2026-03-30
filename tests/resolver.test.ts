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

  assert.deepEqual(plan.mergeOrder, ["default", "local"]);
  assert.equal(plan.execution?.pluginPackage, "envheaven-test-plugin");
  assert.equal(plan.execution?.args[0], "local-script");
  assert.ok(plan.trace.some((entry) => entry.propertyPath === "Execution.args"));
  assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.code === "optional-layer-missing"));
});

test("normalizes RunCommand into Execution and rejects unsupported conditions", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const discovery = await discoverEnvRepo(repoRoot);
  const repoModel = buildRepoModel(discovery);
  const plan = resolvePlan(repoModel, "fake-local-01");

  assert.equal(plan.execution, null);
  assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.code === "unsupported-condition-type"));
});

test("loads plugins by package name and validates bad plugin contracts", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const okPlugin = await loadPlugin("envheaven-test-plugin", repoRoot);
  const badPlugin = await loadPlugin("envheaven-bad-plugin", repoRoot);

  assert.equal(okPlugin.diagnostics.length, 0);
  assert.ok(typeof okPlugin.plugin.inspect === "function");
  assert.ok(badPlugin.diagnostics.some((diagnostic) => diagnostic.code === "plugin-contract-invalid"));
});
