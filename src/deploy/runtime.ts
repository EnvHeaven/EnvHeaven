import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createDiagnostic } from "../diagnostics";
import { incrementPatchVersion, isValidVersionString } from "../state/store";
import type { Diagnostic } from "../types";

export interface PackageMetadata {
  name: string;
  version: string;
  packageJsonPath: string;
}

export async function readPackageMetadata(packageDirectory: string): Promise<PackageMetadata> {
  const packageJsonPath = path.join(packageDirectory, "package.json");
  const raw = await fs.readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };

  return {
    name: typeof parsed.name === "string" ? parsed.name : path.basename(packageDirectory),
    version: typeof parsed.version === "string" ? parsed.version : "0.1.0",
    packageJsonPath,
  };
}

export async function withTemporaryPackageVersion<T>(
  packageDirectory: string,
  targetVersion: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!isValidVersionString(targetVersion)) {
    throw new Error(`Invalid package version "${targetVersion}".`);
  }

  const packageJsonPath = path.join(packageDirectory, "package.json");
  const originalContent = await fs.readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(originalContent) as Record<string, unknown>;
  parsed.version = targetVersion;

  await fs.writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  try {
    return await action();
  } finally {
    await fs.writeFile(packageJsonPath, originalContent, "utf8");
  }
}

export async function createArtifactDeployTag(
  repoRoot: string,
  artifactDirectory: string,
  version: string,
  deployTarget: string,
): Promise<{ tagName: string; created: boolean; pushed: boolean; message?: string }> {
  const relativeArtifactPath = path.relative(repoRoot, artifactDirectory);
  const repoTopLevel = await runGitAndCapture(["-C", artifactDirectory, "rev-parse", "--show-toplevel"]);
  const normalizedTopLevel = path.resolve(repoTopLevel.stdout.trim());
  const normalizedArtifactDirectory = path.resolve(artifactDirectory);

  if (repoTopLevel.exitCode !== 0 || normalizedTopLevel !== normalizedArtifactDirectory) {
    return {
      tagName: "",
      created: false,
      pushed: false,
      message: `Skipping tag creation because "${relativeArtifactPath}" is not an isolated git repo.`,
    };
  }

  const tagName = `build-v${version}_${deployTarget}`;
  const existingTag = await runGitAndCapture(["-C", artifactDirectory, "tag", "--list", tagName]);
  if (existingTag.stdout.trim() === tagName) {
    return {
      tagName,
      created: false,
      pushed: false,
      message: `Tag "${tagName}" already exists in ${relativeArtifactPath}.`,
    };
  }

  const createResult = await runGitAndCapture(["-C", artifactDirectory, "tag", tagName]);
  if (createResult.exitCode !== 0) {
    return {
      tagName,
      created: false,
      pushed: false,
      message: createResult.stderr || `Failed to create tag "${tagName}".`,
    };
  }

  let pushed = false;
  if (process.env.EH_GIT_PUSH_TAGS === "1") {
    const pushResult = await runGitAndCapture(["-C", artifactDirectory, "push", "origin", `refs/tags/${tagName}`]);
    pushed = pushResult.exitCode === 0;
    if (!pushed) {
      return {
        tagName,
        created: true,
        pushed: false,
        message: pushResult.stderr || `Tag "${tagName}" was created locally but failed to push.`,
      };
    }
  }

  return {
    tagName,
    created: true,
    pushed,
  };
}

export function buildVersionFallbackDiagnostic(
  artifactName: string,
  fallbackVersion: string,
): Diagnostic {
  return createDiagnostic(
    "warning",
    "dynamic-artifact-version-fallback",
    `Artifact "${artifactName}" is using fallback version "${fallbackVersion}" because no version registry entry exists yet.`,
  );
}

export function buildMissingProductionVersionDiagnostic(artifactName: string, packageVersion: string): Diagnostic {
  return createDiagnostic(
    "warning",
    "production-version-fallback",
    `Artifact "${artifactName}" has no configured next version; falling back to package.json version "${packageVersion}".`,
  );
}

export function computeNextVersionSuggestion(version: string): string {
  return incrementPatchVersion(version);
}

async function runGitAndCapture(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, {
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
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message,
      });
    });
  });
}
