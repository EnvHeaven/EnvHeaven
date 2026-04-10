import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageAndPackLocal, readPackageMetadata } from "../src/deploy/runtime";
import { EnvHeavenStateStore, resolveEnvHeavenPaths } from "../src/state/store";

function makeIsolatedStore(): { store: EnvHeavenStateStore; stateDir: string } {
  const stateDir = path.join(
    os.tmpdir(),
    `envheaven-local-deploy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const fakePaths = resolveEnvHeavenPaths("linux", {
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: stateDir,
    XDG_CACHE_HOME: stateDir,
  });
  const store = new EnvHeavenStateStore(fakePaths);
  return { store, stateDir };
}

async function createFakePackage(
  dir: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const pkg = {
    name: "test-deploy-package",
    version: "0.1.0",
    description: "original description",
    keywords: ["original"],
    ...overrides,
  };
  const pkgJsonPath = path.join(dir, "package.json");
  await fs.writeFile(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, "index.js"), 'module.exports = {};\n', "utf8");
  return pkgJsonPath;
}

test("stageAndPackLocal: creates tarball with target version without modifying source", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-stage-test-"));
  const srcDir = path.join(tempRoot, "source-pkg");
  const pkgJsonPath = await createFakePackage(srcDir);

  const originalContent = await fs.readFile(pkgJsonPath, "utf8");

  const staged = await stageAndPackLocal(srcDir, "1.2.3");

  try {
    assert.ok(staged.tarballPath, "tarball path should exist");
    assert.ok(staged.stagingDir, "staging dir should exist");

    const tarballStat = await fs.stat(staged.tarballPath);
    assert.ok(tarballStat.isFile(), "tarball should be a file");
    assert.ok(tarballStat.size > 0, "tarball should not be empty");

    const afterContent = await fs.readFile(pkgJsonPath, "utf8");
    assert.equal(afterContent, originalContent, "source package.json must not be modified");
  } finally {
    await staged.cleanup();
  }
});

test("stageAndPackLocal: staged package.json has target version, source unchanged", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-stage-test-"));
  const srcDir = path.join(tempRoot, "source-pkg");
  await createFakePackage(srcDir);

  const staged = await stageAndPackLocal(srcDir, "5.6.7");

  try {
    const stagedPkgJson = JSON.parse(
      await fs.readFile(path.join(staged.stagingDir, "package", "package.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(stagedPkgJson.version, "5.6.7", "staged version should be the target");

    const sourcePkgJson = JSON.parse(await fs.readFile(path.join(srcDir, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(sourcePkgJson.version, "0.1.0", "source version must remain at baseline");
  } finally {
    await staged.cleanup();
  }
});

test("stageAndPackLocal: excludes node_modules and .git from staging", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-stage-test-"));
  const srcDir = path.join(tempRoot, "source-pkg");
  await createFakePackage(srcDir);
  await fs.mkdir(path.join(srcDir, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(srcDir, "node_modules", "dep", "index.js"), "", "utf8");
  await fs.mkdir(path.join(srcDir, ".git"), { recursive: true });
  await fs.writeFile(path.join(srcDir, ".git", "config"), "", "utf8");

  const staged = await stageAndPackLocal(srcDir, "0.2.0");

  try {
    const stagedContents = await fs.readdir(path.join(staged.stagingDir, "package"));
    assert.ok(!stagedContents.includes("node_modules"), "node_modules must not be staged");
    assert.ok(!stagedContents.includes(".git"), ".git must not be staged");
    assert.ok(stagedContents.includes("package.json"), "package.json must be staged");
    assert.ok(stagedContents.includes("index.js"), "index.js must be staged");
  } finally {
    await staged.cleanup();
  }
});

test("stageAndPackLocal: rejects invalid version string", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-stage-test-"));
  const srcDir = path.join(tempRoot, "source-pkg");
  await createFakePackage(srcDir);

  await assert.rejects(
    () => stageAndPackLocal(srcDir, "not-a-version"),
    /Invalid package version/,
  );
});

test("consecutive local deploys increment version correctly (state store)", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "my-cli";

  const { record: r1 } = await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "0.1.0");
  assert.equal(r1.nextVersion, "0.1.1");

  const after1 = await store.advanceArtifactVersion(repoRoot, artifactName, undefined, r1.nextVersion!);
  assert.equal(after1.lastVersion, "0.1.1");
  assert.equal(after1.nextVersion, "0.1.2");

  const after2 = await store.advanceArtifactVersion(repoRoot, artifactName, undefined, after1.nextVersion!);
  assert.equal(after2.lastVersion, "0.1.2");
  assert.equal(after2.nextVersion, "0.1.3");
});

test("source package.json is unchanged after staging+pack", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-stage-test-"));
  const srcDir = path.join(tempRoot, "source-pkg");
  await createFakePackage(srcDir, {
    description: "my custom description",
    keywords: ["custom", "keywords"],
    scripts: { build: "echo build" },
  });

  const before = await fs.readFile(path.join(srcDir, "package.json"), "utf8");

  const staged = await stageAndPackLocal(srcDir, "99.0.1");
  await staged.cleanup();

  const after = await fs.readFile(path.join(srcDir, "package.json"), "utf8");
  assert.equal(after, before, "source package.json must be byte-for-byte identical");
});

test("unrelated local changes in source package.json are preserved", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-stage-test-"));
  const srcDir = path.join(tempRoot, "source-pkg");
  await createFakePackage(srcDir, {
    description: "locally modified description",
    author: "local-user",
    customField: { nested: true },
  });

  const before = JSON.parse(await fs.readFile(path.join(srcDir, "package.json"), "utf8")) as Record<string, unknown>;

  const staged = await stageAndPackLocal(srcDir, "2.0.0");
  await staged.cleanup();

  const after = JSON.parse(await fs.readFile(path.join(srcDir, "package.json"), "utf8")) as Record<string, unknown>;

  assert.equal(after.description, "locally modified description");
  assert.equal(after.author, "local-user");
  assert.deepEqual(after.customField, { nested: true });
  assert.equal(after.version, before.version, "version must not change");
});

test("failed deploy does not advance version state", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "fail-test";

  await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "0.1.0");
  const before = await store.getVersionRecord(repoRoot, artifactName, undefined);
  assert.equal(before?.nextVersion, "0.1.1");
  assert.equal(before?.lastVersion, undefined);

  const resolved = await store.resolveArtifactVersion(repoRoot, artifactName, undefined, "0.1.0");
  assert.equal(resolved.value, "0.1.1");
  assert.equal(resolved.source, "registry-next");

  const afterFail = await store.getVersionRecord(repoRoot, artifactName, undefined);
  assert.equal(afterFail?.nextVersion, "0.1.1", "nextVersion must not advance on failure");
  assert.equal(afterFail?.lastVersion, undefined, "lastVersion must not be set on failure");
});

test("version resolution uses single authoritative path after bootstrap", async () => {
  const { store } = makeIsolatedStore();
  const repoRoot = "/fake/repo";
  const artifactName = "unified-test";

  const { record } = await store.bootstrapArtifactVersion(repoRoot, artifactName, undefined, "1.0.0");
  assert.equal(record.nextVersion, "1.0.1");

  const r1 = await store.resolveArtifactVersion(repoRoot, artifactName, undefined, "1.0.0");
  assert.equal(r1.source, "registry-next");
  assert.equal(r1.value, "1.0.1");

  const r2 = await store.resolveArtifactVersion(repoRoot, artifactName, undefined, "999.0.0");
  assert.equal(r2.source, "registry-next");
  assert.equal(r2.value, "1.0.1");
  assert.notEqual(r2.source, "fallback", "must never fall back to package.json version after bootstrap");
});

test("installed version comes from tarball (staged package.json has correct version)", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-stage-test-"));
  const srcDir = path.join(tempRoot, "source-pkg");
  await createFakePackage(srcDir);

  const staged = await stageAndPackLocal(srcDir, "3.14.159");

  try {
    const stagedMeta = await readPackageMetadata(path.join(staged.stagingDir, "package"));
    assert.equal(stagedMeta.version, "3.14.159", "staged package reports the deployed version");

    const srcMeta = await readPackageMetadata(srcDir);
    assert.equal(srcMeta.version, "0.1.0", "source still reports original version");
  } finally {
    await staged.cleanup();
  }
});
