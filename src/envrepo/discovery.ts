import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { createDiagnostic } from "../diagnostics";
import type { Diagnostic, EnvRepoFile, RepoDiscoveryResult } from "../types";

const ENV_DIR_NAME = ".envheaven";
const FILE_SUFFIX = ".envheaven.env-map-layer.json";
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "fixtures",
]);

export async function discoverEnvRepo(rootDirectory: string): Promise<RepoDiscoveryResult> {
  const envDirectories = await findEnvDirectories(rootDirectory);
  const files: EnvRepoFile[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const envDirectory of envDirectories.sort()) {
    const discoveredFiles = await collectLayerFiles(envDirectory);
    files.push(...discoveredFiles);
  }

  files.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));

  if (envDirectories.length === 0) {
    diagnostics.push(
      createDiagnostic("warning", "env-directory-missing", "No .envheaven directory was discovered.", rootDirectory),
    );
  }

  for (const file of files) {
    diagnostics.push(...file.diagnostics);
  }

  return {
    rootDirectory,
    envDirectories,
    files,
    diagnostics,
  };
}

async function findEnvDirectories(rootDirectory: string): Promise<string[]> {
  const found: string[] = [];
  await walkDirectories(rootDirectory, async (directoryPath, direntNames) => {
    for (const direntName of direntNames) {
      if (direntName === ENV_DIR_NAME) {
        found.push(path.join(directoryPath, direntName));
      }
    }
  });
  return found;
}

async function walkDirectories(
  currentDirectory: string,
  onDirectory: (directoryPath: string, direntNames: string[]) => Promise<void>,
): Promise<void> {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  const direntNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  await onDirectory(currentDirectory, direntNames);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    await walkDirectories(path.join(currentDirectory, entry.name), onDirectory);
  }
}

async function collectLayerFiles(envDirectory: string): Promise<EnvRepoFile[]> {
  const files: EnvRepoFile[] = [];
  await walkEnvDirectory(envDirectory, async (filePath) => {
    if (!filePath.endsWith(FILE_SUFFIX)) {
      return;
    }

    files.push(await parseEnvRepoFile(envDirectory, filePath));
  });
  return files;
}

async function walkEnvDirectory(currentDirectory: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const resolvedPath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      await walkEnvDirectory(resolvedPath, onFile);
      continue;
    }

    if (entry.isFile()) {
      await onFile(resolvedPath);
    }
  }
}

async function parseEnvRepoFile(envDirectory: string, filePath: string): Promise<EnvRepoFile> {
  const diagnostics: Diagnostic[] = [];

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const errors: ParseError[] = [];
    const payload = parseJsonc(raw, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });

    for (const error of errors) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "jsonc-parse-error",
          `Failed to parse JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}.`,
          filePath,
        ),
      );
    }

    return {
      sourcePath: filePath,
      relativePath: path.relative(envDirectory, filePath),
      fileName: path.basename(filePath),
      payload: isRecord(payload) ? payload : null,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "file-read-error",
        error instanceof Error ? error.message : "Unknown file read error.",
        filePath,
      ),
    );

    return {
      sourcePath: filePath,
      relativePath: path.relative(envDirectory, filePath),
      fileName: path.basename(filePath),
      payload: null,
      diagnostics,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
