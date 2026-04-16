import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveWorkspaceRoot,
  matchArtifactToEnvMap,
} from "../src/envrepo/workspace-routing";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eh-ws-routing-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveWorkspaceRoot", () => {
  it("returns startDirectory when .envheaven exists at root", async () => {
    await fs.mkdir(path.join(tmpDir, ".envheaven"), { recursive: true });
    const result = await resolveWorkspaceRoot(tmpDir);
    assert.strictEqual(result.envRepoRoot, tmpDir);
    assert.strictEqual(result.artifactContext, null);
  });

  it("walks up to find .envheaven in ancestor", async () => {
    const envRepoRoot = tmpDir;
    await fs.mkdir(path.join(envRepoRoot, ".envheaven"), { recursive: true });
    const artifactDir = path.join(envRepoRoot, "artifacts", "my-app");
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, "package.json"), '{"name":"my-app"}');

    const result = await resolveWorkspaceRoot(artifactDir);
    assert.strictEqual(result.envRepoRoot, envRepoRoot);
    assert.notStrictEqual(result.artifactContext, null);
    assert.strictEqual(result.artifactContext!.artifactName, "my-app");
  });

  it("returns warning when no .envheaven found", async () => {
    const deepDir = path.join(tmpDir, "a", "b", "c");
    await fs.mkdir(deepDir, { recursive: true });
    const result = await resolveWorkspaceRoot(deepDir);
    assert.ok(result.diagnostics.some((d) => d.code === "workspace-routing-not-found"));
  });
});

describe("matchArtifactToEnvMap", () => {
  it("matches artifact by RepoCloneFolderPath", () => {
    const artifacts = {
      "web-site-01-fe-01": {
        RepoCloneFolderPath: "./artifacts/jd-eh-ws-fe-01",
      },
      "eh-web-site-01-cdn-01": {
        RepoCloneFolderPath: "./artifacts/jd-eh-ws-fe-cdn-01",
      },
    };
    const matched = matchArtifactToEnvMap("./artifacts/jd-eh-ws-fe-01", artifacts);
    assert.strictEqual(matched, "web-site-01-fe-01");
  });

  it("matches without leading ./", () => {
    const artifacts = {
      "eh-web-site-01-cdn-01": {
        RepoCloneFolderPath: "./artifacts/jd-eh-ws-fe-cdn-01",
      },
    };
    const matched = matchArtifactToEnvMap("artifacts/jd-eh-ws-fe-cdn-01", artifacts);
    assert.strictEqual(matched, "eh-web-site-01-cdn-01");
  });

  it("returns null when no match", () => {
    const artifacts = {
      "eh-web-site-01-cdn-01": {
        RepoCloneFolderPath: "./artifacts/other",
      },
    };
    const matched = matchArtifactToEnvMap("./artifacts/nope", artifacts);
    assert.strictEqual(matched, null);
  });
});
