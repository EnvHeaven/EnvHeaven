import { createRequire } from "node:module";
import path from "node:path";
import { createDiagnostic } from "../diagnostics";
import type { Diagnostic, EnvHeavenPlugin, LoadedPlugin } from "../types";

const LEGACY_PACKAGE_RENAMES: Record<string, string> = {
  "@envheaven/plugins/nodejs-pnpm": "@envheaven/plugins-nodejs-pnpm",
  "@envheaven/plugins/firebase-hosting-deploy": "@envheaven/plugins-firebase-hosting-deploy",
};

export async function loadPlugin(packageName: string, repoRoot: string): Promise<LoadedPlugin> {
  const diagnostics: Diagnostic[] = [];
  const packageValidation = validatePackageName(packageName);
  if (packageValidation) {
    diagnostics.push(packageValidation);
    return {
      packageName,
      resolvedPath: "",
      plugin: {},
      diagnostics,
    };
  }

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

function validatePackageName(packageName: string): Diagnostic | null {
  const suggestedName = LEGACY_PACKAGE_RENAMES[packageName];
  if (suggestedName) {
    return createDiagnostic(
      "error",
      "plugin-package-name-invalid",
      `Invalid plugin package name "${packageName}". Use "${suggestedName}" instead.`,
    );
  }

  const slashCount = [...packageName].filter((character) => character === "/").length;
  const isScoped = packageName.startsWith("@");
  if ((isScoped && slashCount !== 1) || (!isScoped && slashCount !== 0)) {
    return createDiagnostic(
      "error",
      "plugin-package-name-invalid",
      `Invalid npm package name "${packageName}". Scoped packages must use "@scope/name".`,
    );
  }

  const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
  if (!packageNamePattern.test(packageName)) {
    return createDiagnostic(
      "error",
      "plugin-package-name-invalid",
      `Invalid npm package name "${packageName}".`,
    );
  }

  return null;
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
