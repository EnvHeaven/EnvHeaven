import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  EnvHeavenStateStore,
  getTrackState,
  incrementBetaVersion,
  incrementPatchVersion,
  resolveEnvHeavenPaths,
} from "../src/state/store";

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
  assert.equal(getTrackState(record, "release")?.nextVersion, incrementPatchVersion(packageJsonVersion));
  assert.equal(getTrackState(record, "release")?.nextVersion, "1.2.4");
  assert.equal(getTrackState(record, "release")?.lastVersion, undefined);
});

test("bootstrapArtifactVersion: can bootstrap directly onto the exp track", async () => {
  const { store } = makeIsolatedStore();
  const { record, bootstrapped } = await store.bootstrapArtifactVersion("/fake/repo", "exp-artifact", undefined, "1.2.3", "exp");

  assert.equal(bootstrapped, true);
  assert.equal(record.nextVersion, "1.2.4");
  assert.equal(getTrackState(record, "release")?.nextVersion, "1.2.4");
  assert.equal(getTrackState(record, "exp")?.nextVersion, "1.2.4-exp.0");
});

test("bootstrapArtifactVersion: can bootstrap directly onto the beta track", async () => {
  const { store } = makeIsolatedStore();
  const { record, bootstrapped } = await store.bootstrapArtifactVersion("/fake/repo", "beta-artifact", undefined, "1.2.3", "beta");

  assert.equal(bootstrapped, true);
  assert.equal(record.nextVersion, "1.2.4");
  assert.equal(getTrackState(record, "release")?.nextVersion, "1.2.4");
  assert.equal(getTrackState(record, "beta")?.nextVersion, "1.2.4-beta.0");
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

test("tracks are kept in parallel until release advances", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "parallel-artifact";

  await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "0.1.2", "exp");
  await store.advanceArtifactVersion(repoRoot, artifactName, undefined, "0.1.3-exp.2", "exp");
  await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "0.1.2", "beta");
  await store.advanceArtifactVersion(repoRoot, artifactName, undefined, "0.1.3-beta.0", "beta");

  const afterBeta = await store.getVersionRecord(repoRoot, artifactName, undefined);
  assert.equal(getTrackState(afterBeta, "exp")?.nextVersion, "0.1.3-exp.3");
  assert.equal(getTrackState(afterBeta, "beta")?.nextVersion, "0.1.3-beta.1");
  assert.equal(getTrackState(afterBeta, "release")?.nextVersion, "0.1.3");

  await store.advanceArtifactVersion(repoRoot, artifactName, undefined, "0.1.3", "patch");
  const afterRelease = await store.getVersionRecord(repoRoot, artifactName, undefined);
  assert.equal(getTrackState(afterRelease, "release")?.lastVersion, "0.1.3");
  assert.equal(getTrackState(afterRelease, "release")?.nextVersion, "0.1.4");
  assert.equal(getTrackState(afterRelease, "exp")?.nextVersion, "0.1.4-exp.0");
  assert.equal(getTrackState(afterRelease, "beta")?.nextVersion, "0.1.4-beta.0");
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

test("after bootstrap, resolveArtifactVersion source is never 'fallback' (dynamic-artifact-version-fallback path eliminated)", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "bootstrap-no-fallback";

  await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "2.3.4");

  const resolved = await store.resolveArtifactVersion(repoRoot, artifactName, undefined, "999.9.9");

  assert.notEqual(resolved.source, "fallback", "source must not be fallback after bootstrap");
  assert.equal(resolved.source, "registry-next");
  assert.equal(resolved.value, "2.3.5");
});

test("advanceArtifactVersion: can continue the exp track", async () => {
  const { store } = makeIsolatedStore();
  const record = await store.advanceArtifactVersion("/fake/repo", "exp-artifact", undefined, "2.0.1-exp.0", "exp");

  assert.equal(record.lastVersion, undefined);
  assert.equal(record.nextVersion, undefined);
  assert.equal(getTrackState(record, "exp")?.lastVersion, "2.0.1-exp.0");
  assert.equal(getTrackState(record, "exp")?.nextVersion, "2.0.1-exp.1");
});

test("advanceArtifactVersion: can promote exp builds onto the beta track", async () => {
  const { store } = makeIsolatedStore();
  const record = await store.advanceArtifactVersion("/fake/repo", "beta-artifact", undefined, "2.0.1-exp.3", "beta");

  assert.equal(record.lastVersion, undefined);
  assert.equal(record.nextVersion, undefined);
  assert.equal(getTrackState(record, "beta")?.lastVersion, "2.0.1-exp.3");
  assert.equal(getTrackState(record, "beta")?.nextVersion, incrementBetaVersion("2.0.1-exp.3"));
  assert.equal(getTrackState(record, "beta")?.nextVersion, "2.0.1-beta.0");
});

test("normalization repairs poisoned prerelease values written into the release lane", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const repoRecord = await store.rememberRepo(repoRoot);
  repoRecord.artifacts["poisoned-artifact"] = {
    artifactName: "poisoned-artifact",
    lastVersion: "0.1.3-exp.3",
    nextVersion: "0.1.3-exp.4",
    tracks: {
      release: {
        lastVersion: "0.1.3-exp.3",
        nextVersion: "0.1.3-exp.4",
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };

  await (store as unknown as { saveState(state: unknown): Promise<void> }).saveState({
    schemaVersion: 1,
    selectedRepoId: repoRecord.repoId,
    recentRepoIds: [repoRecord.repoId],
    repos: {
      [repoRecord.repoId]: repoRecord,
    },
  });
  store.invalidateCache();

  const repaired = await store.getVersionRecord(repoRoot, "poisoned-artifact", undefined);
  assert.equal(repaired?.lastVersion, "0.1.2");
  assert.equal(repaired?.nextVersion, "0.1.3");
  assert.equal(getTrackState(repaired, "release")?.lastVersion, "0.1.2");
  assert.equal(getTrackState(repaired, "release")?.nextVersion, "0.1.3");
  assert.equal(getTrackState(repaired, "exp")?.nextVersion, "0.1.3-exp.4");
  assert.equal(getTrackState(repaired, "exp")?.lastVersion, "0.1.3-exp.3");
});

test("normalization repairs half-repaired records with matching release last/next", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const repoRecord = await store.rememberRepo(repoRoot);
  repoRecord.artifacts["half-repaired-artifact"] = {
    artifactName: "half-repaired-artifact",
    lastVersion: "0.1.4",
    nextVersion: "0.1.4",
    tracks: {
      release: {
        lastVersion: "0.1.4",
        nextVersion: "0.1.4",
        updatedAt: new Date().toISOString(),
      },
      exp: {
        lastVersion: "0.1.4-exp.1",
        nextVersion: "0.1.4-exp.2",
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };

  await (store as unknown as { saveState(state: unknown): Promise<void> }).saveState({
    schemaVersion: 1,
    selectedRepoId: repoRecord.repoId,
    recentRepoIds: [repoRecord.repoId],
    repos: {
      [repoRecord.repoId]: repoRecord,
    },
  });
  store.invalidateCache();

  const repaired = await store.getVersionRecord(repoRoot, "half-repaired-artifact", undefined);
  assert.equal(getTrackState(repaired, "release")?.lastVersion, "0.1.3");
  assert.equal(getTrackState(repaired, "release")?.nextVersion, "0.1.4");
  assert.equal(getTrackState(repaired, "exp")?.nextVersion, "0.1.4-exp.2");
});
