import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildBuildContext,
  materializeBuildContext,
  readBuildContext,
  cleanBuildContext,
  resolveBuildVersion,
  resolveVariables,
} from "../src/deploy/materialization";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "eh-mat-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveBuildVersion", () => {
  it("prefers nextVersion when available", () => {
    assert.strictEqual(resolveBuildVersion("1.2.3", "1.2.2", "1.0.0"), "1.2.3");
  });

  it("falls back to lastVersion", () => {
    assert.strictEqual(resolveBuildVersion(null, "1.2.2", "1.0.0"), "1.2.2");
  });

  it("falls back to packageJsonVersion", () => {
    assert.strictEqual(resolveBuildVersion(null, null, "1.0.0"), "1.0.0");
  });
});

describe("resolveVariables", () => {
  it("includes deploy target and version", () => {
    const vars = resolveVariables({ API_URL: "https://api.example.com" }, "beta-01", "2.0.0");
    assert.strictEqual(vars["EH_DEPLOY_TARGET"], "beta-01");
    assert.strictEqual(vars["EH_ARTIFACT_VERSION"], "2.0.0");
    assert.strictEqual(vars["API_URL"], "https://api.example.com");
    assert.ok(vars["EH_BUILD_TIMESTAMP"]);
  });

  it("applies extra overrides", () => {
    const vars = resolveVariables({}, "local-01", "1.0.0", { CUSTOM: "value" });
    assert.strictEqual(vars["CUSTOM"], "value");
  });
});

describe("materializeBuildContext", () => {
  it("writes and reads back build context", async () => {
    const context = buildBuildContext(
      "web-app-front-end-01",
      "beta-01",
      "beta",
      "2.0.0",
      { ENVIRONMENT_NAME: "beta" },
    );

    const result = await materializeBuildContext(tmpDir, context);
    assert.ok(result.contextFilePath.endsWith(".envheaven-build-context.json"));
    assert.ok(result.diagnostics.some((d) => d.code === "build-context-materialized"));

    const readBack = await readBuildContext(tmpDir);
    assert.notStrictEqual(readBack, null);
    assert.strictEqual(readBack!.version, "2.0.0");
    assert.strictEqual(readBack!.target, "beta-01");
    assert.strictEqual(readBack!.artifactName, "web-app-front-end-01");
  });

  it("cleanBuildContext removes the file", async () => {
    const context = buildBuildContext("test", "local-01", "local", "1.0.0", {});
    await materializeBuildContext(tmpDir, context);

    const cleanDiagnostics = await cleanBuildContext(tmpDir);
    assert.ok(cleanDiagnostics.some((d) => d.code === "build-context-cleaned"));

    const readBack = await readBuildContext(tmpDir);
    assert.strictEqual(readBack, null);
  });

  it("does not mutate original source files", async () => {
    const sourceDir = path.join(tmpDir, "source");
    const buildDir = path.join(tmpDir, "build");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "app.ts"), "const x = 1;");

    const context = buildBuildContext("test", "production-01", "production", "3.0.0", {});
    await materializeBuildContext(buildDir, context);

    const sourceContent = await fs.readFile(path.join(sourceDir, "app.ts"), "utf8");
    assert.strictEqual(sourceContent, "const x = 1;");

    const buildContextExists = await readBuildContext(buildDir);
    assert.notStrictEqual(buildContextExists, null);

    const sourceContextExists = await readBuildContext(sourceDir);
    assert.strictEqual(sourceContextExists, null);
  });
});
