import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createArtifactDeployTag, withPermanentPackageVersion, withTemporaryPackageVersion } from "../src/deploy/runtime";

test("temporarily overrides package.json version and restores it on success", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-runtime-"));
  const packageDirectory = path.join(tempRoot, "artifact");
  const packageJsonPath = path.join(packageDirectory, "package.json");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify({ name: "test-package", version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );

  let versionDuringAction = "";
  await withTemporaryPackageVersion(packageDirectory, "1.0.393", async () => {
    versionDuringAction = JSON.parse(await fs.readFile(packageJsonPath, "utf8")).version as string;
  });

  const restoredVersion = JSON.parse(await fs.readFile(packageJsonPath, "utf8")).version as string;
  assert.equal(versionDuringAction, "1.0.393");
  assert.equal(restoredVersion, "0.1.0");
});

test("temporarily overrides package.json version and restores it on failure", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-runtime-"));
  const packageDirectory = path.join(tempRoot, "artifact");
  const packageJsonPath = path.join(packageDirectory, "package.json");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify({ name: "test-package", version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(async () => {
    await withTemporaryPackageVersion(packageDirectory, "1.0.394", async () => {
      throw new Error("boom");
    });
  });

  const restoredVersion = JSON.parse(await fs.readFile(packageJsonPath, "utf8")).version as string;
  assert.equal(restoredVersion, "0.1.0");
});

test("withPermanentPackageVersion: writes version and does not restore it after action", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-runtime-"));
  const packageDirectory = path.join(tempRoot, "artifact");
  const packageJsonPath = path.join(packageDirectory, "package.json");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify({ name: "test-package", version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );

  let versionDuringAction = "";
  await withPermanentPackageVersion(packageDirectory, "0.1.7", async () => {
    versionDuringAction = JSON.parse(await fs.readFile(packageJsonPath, "utf8")).version as string;
  });

  const versionAfterAction = JSON.parse(await fs.readFile(packageJsonPath, "utf8")).version as string;
  assert.equal(versionDuringAction, "0.1.7");
  assert.equal(versionAfterAction, "0.1.7");
});

test("withPermanentPackageVersion: version persists even when action throws", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-runtime-"));
  const packageDirectory = path.join(tempRoot, "artifact");
  const packageJsonPath = path.join(packageDirectory, "package.json");
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify({ name: "test-package", version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(async () => {
    await withPermanentPackageVersion(packageDirectory, "0.1.8", async () => {
      throw new Error("install failed");
    });
  });

  const versionAfterFailure = JSON.parse(await fs.readFile(packageJsonPath, "utf8")).version as string;
  assert.equal(versionAfterFailure, "0.1.8");
});

test("creates a local deploy tag inside an artifact git repo", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-runtime-"));
  const repoRoot = path.join(tempRoot, "repo");
  const artifactDirectory = path.join(repoRoot, "artifacts", "plugin");
  await fs.mkdir(artifactDirectory, { recursive: true });
  await runGit(["init", "-b", "main"], artifactDirectory);
  await fs.writeFile(
    path.join(artifactDirectory, "package.json"),
    `${JSON.stringify({ name: "@envheaven/plugins-offiline-web-ui", version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );
  await runGit(["config", "user.email", "envheaven@example.com"], artifactDirectory);
  await runGit(["config", "user.name", "EnvHeaven Tests"], artifactDirectory);
  await runGit(["add", "package.json"], artifactDirectory);
  await runGit(["commit", "-m", "initial"], artifactDirectory);

  const tagResult = await createArtifactDeployTag(repoRoot, artifactDirectory, "1.0.393", "production-01");
  const existingTagResult = await createArtifactDeployTag(repoRoot, artifactDirectory, "1.0.393", "production-01");
  const tagList = await runGit(["tag", "--list"], artifactDirectory);

  assert.equal(tagResult.created, true);
  assert.equal(tagResult.tagName, "build-v1.0.393_production-01");
  assert.match(tagList.stdout, /build-v1\.0\.393_production-01/);
  assert.equal(existingTagResult.created, false);
  assert.match(existingTagResult.message ?? "", /already exists/);
});

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (exitCode) => {
      if ((exitCode ?? 1) === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || `git ${args.join(" ")} failed with exit code ${String(exitCode)}.`));
    });
    child.on("error", reject);
  });
}
