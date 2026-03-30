import { createRequire } from "node:module";
import path from "node:path";
import { createDiagnostic } from "../diagnostics";
import type { Diagnostic, EnvHeavenPlugin, LoadedPlugin } from "../types";

export async function loadPlugin(packageName: string, repoRoot: string): Promise<LoadedPlugin> {
  const diagnostics: Diagnostic[] = [];
  const localRequire = createRequire(path.join(repoRoot, "package.json"));

  try {
    const resolvedPath = localRequire.resolve(packageName);
    const imported = localRequire(resolvedPath) as { default?: unknown } | EnvHeavenPlugin;
    const plugin = normalizePlugin(imported);

    if (!plugin.inspect && !plugin.execute) {
      diagnostics.push(
        createDiagnostic(
          "error",
          "plugin-contract-invalid",
          `Plugin "${packageName}" must export inspect() and/or execute().`,
          resolvedPath,
        ),
      );
    }

    return {
      packageName,
      resolvedPath,
      plugin,
      diagnostics,
    };
  } catch (error) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "plugin-load-failed",
        error instanceof Error ? error.message : `Failed to load "${packageName}".`,
        repoRoot,
      ),
    );

    return {
      packageName,
      resolvedPath: "",
      plugin: {},
      diagnostics,
    };
  }
}

function normalizePlugin(imported: { default?: unknown } | EnvHeavenPlugin): EnvHeavenPlugin {
  if (isPlugin(imported)) {
    return imported;
  }

  if (imported && typeof imported === "object" && "default" in imported && isPlugin(imported.default)) {
    return imported.default;
  }

  return {};
}

function isPlugin(value: unknown): value is EnvHeavenPlugin {
  return typeof value === "object" && value !== null;
}
