import { createDiagnostic } from "../diagnostics";
import type { CommandIntent, Diagnostic, SupportedTarget } from "../types";

const RUN_TARGET_KEYWORDS = new Set([
  "default",
  "local",
  "local-01",
  "development",
  "development-01",
  "fake",
  "fake-local",
  "fake-local-01",
  "install-revert",
  "install-revert-01",
]);

const DEPLOY_TARGET_KEYWORDS = new Set<string>([
  "local",
  "local-01",
  "development",
  "development-01",
  "beta",
  "beta-01",
  "production",
  "production-01",
]);

const SPECIAL_COMMAND_KEYWORDS = new Set([
  "offiline-web-ui",
  "offline-web-ui",
  "version",
]);

const NOUN_COMMANDS = new Set(["daemon", "ui"]);
const NOUN_SUBCOMMANDS = new Set(["stop", "restart", "status"]);

const HARD_REJECT_KEYWORDS = new Set(["last"]);

export function inferCommandIntent(args: string[]): {
  intent: CommandIntent | null;
  diagnostics: Diagnostic[];
} {
  const trimmedArgs = args.map((token) => token.trim()).filter((token) => token.length > 0);
  const normalizedTokens = trimmedArgs.map((token) => token.toLowerCase());

  if (normalizedTokens.length === 0) {
    return {
      intent: {
        kind: "daemon",
        rawArgs: args,
        normalizedTokens,
      },
      diagnostics: [],
    };
  }

  for (const token of normalizedTokens) {
    if (HARD_REJECT_KEYWORDS.has(token)) {
      return {
        intent: null,
        diagnostics: [
          createDiagnostic("error", "unsupported-command", `Unsupported token "${token}" in v0.1.0.`),
        ],
      };
    }
  }

  const runCount = normalizedTokens.filter((token) => token === "run").length;
  const deployCount = normalizedTokens.filter((token) => token === "deploy").length;
  const versionCount = normalizedTokens.filter((token) => token === "version").length;
  const offilineCount = normalizedTokens.filter((token) => token !== "version" && SPECIAL_COMMAND_KEYWORDS.has(token)).length;

  if (versionCount >= 1) {
    return {
      intent: {
        kind: "version",
        rawArgs: args,
        normalizedTokens,
      },
      diagnostics: [],
    };
  }

  if (runCount > 1 || deployCount > 1 || offilineCount > 1) {
    return {
      intent: null,
      diagnostics: [createDiagnostic("error", "ambiguous-command", "Command contains repeated action tags.")],
    };
  }

  if ([runCount > 0, deployCount > 0, offilineCount > 0].filter(Boolean).length > 1) {
    return {
      intent: null,
      diagnostics: [createDiagnostic("error", "ambiguous-command", "Command cannot mix run, deploy, and offiline-web-ui tags.")],
    };
  }

  if (offilineCount === 1) {
    if (normalizedTokens.length !== 1) {
      return {
        intent: null,
        diagnostics: [createDiagnostic("error", "unsupported-command-shape", "offiline-web-ui does not accept extra tokens.")],
      };
    }

    return {
      intent: {
        kind: "offiline-web-ui",
        rawArgs: args,
        normalizedTokens,
      },
      diagnostics: [],
    };
  }

  if (runCount === 0 && deployCount === 0) {
    if (normalizedTokens.length === 1 && normalizedTokens[0] === "default") {
      return {
        intent: {
          kind: "run",
          target: "default",
          rawArgs: args,
          normalizedTokens,
        },
        diagnostics: [],
      };
    }

    // Handle: daemon [stop|restart|status]
    if (normalizedTokens.length >= 1 && normalizedTokens[0] === "daemon") {
      if (normalizedTokens.length === 1) {
        return {
          intent: { kind: "daemon", rawArgs: args, normalizedTokens },
          diagnostics: [],
        };
      }
      if (normalizedTokens.length === 2 && NOUN_SUBCOMMANDS.has(normalizedTokens[1])) {
        return {
          intent: {
            kind: "daemon",
            subcommand: normalizedTokens[1] as "stop" | "restart" | "status",
            rawArgs: args,
            normalizedTokens,
          },
          diagnostics: [],
        };
      }
      return {
        intent: null,
        diagnostics: [
          createDiagnostic("error", "unsupported-command-shape", `Unsupported daemon subcommand: "${normalizedTokens.slice(1).join(" ")}". Valid: stop, restart, status.`),
        ],
      };
    }

    // Handle: ui [stop|restart|status]
    if (normalizedTokens.length >= 1 && normalizedTokens[0] === "ui") {
      if (normalizedTokens.length === 1) {
        return {
          intent: { kind: "ui", rawArgs: args, normalizedTokens },
          diagnostics: [],
        };
      }
      if (normalizedTokens.length === 2 && NOUN_SUBCOMMANDS.has(normalizedTokens[1])) {
        return {
          intent: {
            kind: "ui",
            subcommand: normalizedTokens[1] as "stop" | "restart" | "status",
            rawArgs: args,
            normalizedTokens,
          },
          diagnostics: [],
        };
      }
      return {
        intent: null,
        diagnostics: [
          createDiagnostic("error", "unsupported-command-shape", `Unsupported ui subcommand: "${normalizedTokens.slice(1).join(" ")}". Valid: stop, restart, status.`),
        ],
      };
    }

    return {
      intent: null,
      diagnostics: [
        createDiagnostic(
          "error",
          "unsupported-command",
          "Only the bare default target is accepted without the run tag in v0.1.0.",
        ),
      ],
    };
  }

  if (runCount === 1) {
    const targetTokens = normalizedTokens.filter((token) => token !== "run");
    const parsedRun = parseSupportedRunTarget(targetTokens);
    if (!parsedRun) {
      return {
        intent: null,
        diagnostics: [
          createDiagnostic(
            "error",
            "unsupported-command-shape",
            `Unsupported or ambiguous run target: "${targetTokens.join(" ")}".`,
          ),
        ],
      };
    }

    return {
      intent: {
        kind: "run",
        target: parsedRun.target,
        rawArgs: args,
        normalizedTokens,
        artifactSelectors: parsedRun.artifactSelectors,
      },
      diagnostics: [],
    };
  }

  const deployTokens = trimmedArgs.filter((token) => token.toLowerCase() !== "deploy");
  const normalizedDeployTokens = deployTokens.map((token) => token.toLowerCase());
  const parsedDeploy = parseSupportedDeployTarget(normalizedDeployTokens);
  if (!parsedDeploy) {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic(
          "error",
          "unsupported-command-shape",
          `Unsupported or ambiguous deploy target: "${normalizedDeployTokens.join(" ")}".`,
        ),
      ],
    };
  }

  return {
    intent: {
      kind: "deploy",
      target: parsedDeploy.target,
      rawArgs: args,
      normalizedTokens,
      artifactSelectors: parsedDeploy.artifactSelectors,
    },
    diagnostics: [],
  };
}

function parseSupportedRunTarget(tokens: string[]): { target: SupportedTarget; artifactSelectors: string[] } | null {
  const targetTokens = tokens.filter((token) => RUN_TARGET_KEYWORDS.has(token));
  const artifactSelectors = tokens.filter((token) => !RUN_TARGET_KEYWORDS.has(token));

  if (targetTokens.length === 1) {
    switch (targetTokens[0]) {
      case "default":
      case "local":
      case "local-01":
      case "development":
      case "development-01":
      case "fake-local":
      case "fake-local-01":
      case "install-revert":
      case "install-revert-01":
        return {
          target: targetTokens[0],
          artifactSelectors,
        };
      default:
        return null;
    }
  }

  if (targetTokens.length === 2 && targetTokens.includes("fake")) {
    if (targetTokens.includes("local")) {
      return {
        target: "fake-local",
        artifactSelectors,
      };
    }

    if (targetTokens.includes("local-01")) {
      return {
        target: "fake-local-01",
        artifactSelectors,
      };
    }
  }

  return null;
}

function parseSupportedDeployTarget(tokens: string[]): { target: SupportedTarget; artifactSelectors: string[] } | null {
  const targetTokens = tokens.filter((token) => DEPLOY_TARGET_KEYWORDS.has(token));
  const artifactSelectors = tokens.filter((token) => !DEPLOY_TARGET_KEYWORDS.has(token));

  if (targetTokens.length !== 1) {
    return null;
  }

  if (targetTokens[0] === "local" || targetTokens[0] === "local-01") {
    return {
      target: "local-01",
      artifactSelectors,
    };
  }

  if (targetTokens[0] === "development" || targetTokens[0] === "development-01") {
    return {
      target: "development-01",
      artifactSelectors,
    };
  }

  if (targetTokens[0] === "beta" || targetTokens[0] === "beta-01") {
    return {
      target: "beta-01",
      artifactSelectors,
    };
  }

  if (targetTokens[0] === "production" || targetTokens[0] === "production-01") {
    return {
      target: "production-01",
      artifactSelectors,
    };
  }

  return null;
}
