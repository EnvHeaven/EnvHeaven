import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { EnvHeavenStateStore, incrementPatchVersion, resolveEnvHeavenPaths } from "../src/state/store";

function makeIsolatedStore(): { store: EnvHeavenStateStore; stateDir: string } {
  const stateDir = path.join(os.tmpdir(), `envheaven-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const fakePaths = resolveEnvHeavenPaths("linux", {
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: stateDir,
    XDG_CACHE_HOME: stateDir,
  });
  const store = new EnvHeavenStateStore(fakePaths);
  return { store, stateDir };
}

test("bootstrapArtifactVersion: first call increments package.json version and persists to registry", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "my-artifact";
  const packageJsonVersion = "1.2.3";

  const { record, bootstrapped } = await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, packageJsonVersion);

  assert.equal(bootstrapped, true);
  assert.equal(record.nextVersion, incrementPatchVersion(packageJsonVersion));
  assert.equal(record.nextVersion, "1.2.4");
  assert.equal(record.lastVersion, undefined);
});

test("bootstrapArtifactVersion: second call returns existing registry entry unchanged", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "my-artifact";

  const first = await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "2.0.0");
  assert.equal(first.bootstrapped, true);
  assert.equal(first.record.nextVersion, "2.0.1");

  const second = await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "9.9.9");
  assert.equal(second.bootstrapped, false);
  assert.equal(second.record.nextVersion, "2.0.1");
});

test("bootstrapArtifactVersion: does not bootstrap when lastVersion already exists", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "my-artifact";

  await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "3.0.0");
  await store.advanceArtifactVersion(repoRoot, artifactName, undefined, "3.1.0");

  const precheck = await store.getVersionRecord(repoRoot, artifactName, undefined);
  assert.equal(precheck?.lastVersion, "3.1.0");
  assert.equal(precheck?.nextVersion, "3.1.1");

  const { record, bootstrapped } = await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "0.0.1");
  assert.equal(bootstrapped, false);
  assert.equal(record.lastVersion, "3.1.0");
  assert.equal(record.nextVersion, "3.1.1");
});

test("bootstrapArtifactVersion: persisted nextVersion survives a fresh store instance (reads from disk)", async () => {
  const { store: storeA, stateDir } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "disk-persist-artifact";

  const { record } = await storeA.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "0.5.0");
  assert.equal(record.nextVersion, "0.5.1");

  const fakePaths = resolveEnvHeavenPaths("linux", {
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: stateDir,
    XDG_CACHE_HOME: stateDir,
  });
  const storeB = new EnvHeavenStateStore(fakePaths);
  const { record: reloaded, bootstrapped } = await storeB.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "9.9.9");

  assert.equal(bootstrapped, false);
  assert.equal(reloaded.nextVersion, "0.5.1");
});

test("bootstrapArtifactVersion: respects packageName scoping", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "scoped-artifact";

  const resultA = await store.bootstrapArtifactVersion(repoRoot, artifactName, "@scope/pkg-a", "1.0.0");
  const resultB = await store.bootstrapArtifactVersion(repoRoot, artifactName, "@scope/pkg-b", "2.0.0");

  assert.equal(resultA.record.nextVersion, "1.0.1");
  assert.equal(resultB.record.nextVersion, "2.0.1");
  assert.equal(resultA.bootstrapped, true);
  assert.equal(resultB.bootstrapped, true);
});

test("resolveArtifactVersion returns registry value after bootstrap (no fallback)", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "resolve-after-bootstrap";

  await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "0.1.0");
  const resolved = await store.resolveArtifactVersion(repoRoot, artifactName, undefined, "0.1.0");

  assert.equal(resolved.source, "registry-next");
  assert.equal(resolved.value, "0.1.1");
});

test("resolveArtifactVersion returns fallback when no registry entry exists", async () => {
  const { store } = makeIsolatedStore();
  const resolved = await store.resolveArtifactVersion("/fake/repo", "no-entry", undefined, "0.1.0");

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.value, "0.1.0");
});
