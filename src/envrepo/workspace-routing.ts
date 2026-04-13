import { promises as fs } from "node:fs";
import path from "node:path";
import { createDiagnostic } from "../diagnostics";
import type { Diagnostic } from "../types";

const ENV_DIR_NAME = ".envheaven";
const ARTIFACT_MARKERS = ["package.json", "angular.json", "tsconfig.json"];

export interface WorkspaceRoutingResult {
  envRepoRoot: string;
  artifactContext: ArtifactContext | null;
  diagnostics: Diagnostic[];
}

export interface ArtifactContext {
  artifactDirectory: string;
  artifactRelativePath: string;
  artifactName: string | null;
}

export async function resolveWorkspaceRoot(
  startDirectory: string,
): Promise<WorkspaceRoutingResult> {
  const diagnostics: Diagnostic[] = [];

  const localEnvDir = path.join(startDirectory, ENV_DIR_NAME);
  if (await isDirectory(localEnvDir)) {
    return {
      envRepoRoot: startDirectory,
      artifactContext: null,
      diagnostics,
    };
  }

  let current = startDirectory;
  const traversed: string[] = [];

  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;

    traversed.push(current);
    current = parent;

    const ancestorEnvDir = path.join(current, ENV_DIR_NAME);
    if (await isDirectory(ancestorEnvDir)) {
      const artifactContext = await detectArtifactContext(
        startDirectory,
        current,
      );

      if (artifactContext) {
        diagnostics.push(
          createDiagnostic(
            "info",
            "workspace-routing-resolved",
            `Resolved workspace root at "${current}" from artifact directory "${startDirectory}".`,
          ),
        );
      }

      return {
        envRepoRoot: current,
        artifactContext,
        diagnostics,
      };
    }
  }

  diagnostics.push(
    createDiagnostic(
      "warning",
      "workspace-routing-not-found",
      `No .envheaven directory found in "${startDirectory}" or any ancestor.`,
    ),
  );

  return {
    envRepoRoot: startDirectory,
    artifactContext: null,
    diagnostics,
  };
}

async function detectArtifactContext(
  artifactDirectory: string,
  envRepoRoot: string,
): Promise<ArtifactContext | null> {
  const isArtifact = await isLikelyArtifactDirectory(artifactDirectory);
  if (!isArtifact) return null;

  const relativePath = path.relative(envRepoRoot, artifactDirectory);
  if (relativePath.startsWith("..")) return null;

  const artifactName = await readArtifactNameFromPackageJson(artifactDirectory);

  return {
    artifactDirectory,
    artifactRelativePath: `./${relativePath}`,
    artifactName,
  };
}

async function isLikelyArtifactDirectory(dir: string): Promise<boolean> {
  for (const marker of ARTIFACT_MARKERS) {
    if (await fileExists(path.join(dir, marker))) {
      return true;
    }
  }
  return false;
}

async function readArtifactNameFromPackageJson(
  dir: string,
): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

export function matchArtifactToEnvMap(
  artifactRelativePath: string,
  artifacts: Record<string, Record<string, unknown>>,
): string | null {
  const normalizedPath = artifactRelativePath.replace(/\\/g, "/");

  for (const [artifactName, artifactConfig] of Object.entries(artifacts)) {
    const repoClonePath =
      (artifactConfig["RepoCloneFolderPath"] as string) ??
      (artifactConfig["repoCloneFolderPath"] as string);
    if (!repoClonePath) continue;

    const normalizedClonePath = repoClonePath.replace(/\\/g, "/");
    if (
      normalizedPath === normalizedClonePath ||
      normalizedPath === normalizedClonePath.replace(/^\.\//, "")
    ) {
      return artifactName;
    }
  }
  return null;
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
