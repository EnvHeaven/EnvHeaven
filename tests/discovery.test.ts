import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discoverEnvRepo } from "../src/envrepo/discovery";

const fixturesRoot = path.join(__dirname, "fixtures");

test("discovers envheaven files recursively and parses JSONC", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-nested");
  const result = await discoverEnvRepo(repoRoot);
  assert.equal(result.envDirectories.length, 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.payload?.EnvMapLayers !== undefined, true);
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.severity === "error"), false);
});

test("emits parse errors for malformed JSONC", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-malformed");
  const result = await discoverEnvRepo(repoRoot);
  assert.equal(result.files.length, 1);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "jsonc-parse-error"));
});

test("ignores nested envheaven fixtures under skipped directories", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-skip-nested");
  const result = await discoverEnvRepo(repoRoot);

  assert.equal(result.envDirectories.length, 1);
  assert.equal(result.files.length, 1);
  assert.equal(
    result.files[0]?.sourcePath.endsWith(path.join(".envheaven", "repo-base.default.envheaven.env-map-layer.json")),
    true,
  );
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "jsonc-parse-error"), false);
});
