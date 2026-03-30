import { createDiagnostic } from "../diagnostics";
import type { CommandIntent, Diagnostic, SupportedTarget } from "../types";

const RUN_TARGET_KEYWORDS = new Set([
  "default",
  "local",
  "local-01",
  "fake",
  "fake-local",
  "fake-local-01",
]);

const DEPLOY_TARGET_KEYWORDS = new Set([
  "local",
  "local-01",
  "production",
  "production-01",
]);

const SPECIAL_COMMAND_KEYWORDS = new Set([
  "offiline-web-ui",
  "offline-web-ui",
]);

const HARD_REJECT_KEYWORDS = new Set(["last", "development"]);

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
  const offilineCount = normalizedTokens.filter((token) => SPECIAL_COMMAND_KEYWORDS.has(token)).length;

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
    if (!targetTokens.every((token) => RUN_TARGET_KEYWORDS.has(token))) {
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

    const target = parseSupportedRunTarget(targetTokens);
    if (!target) {
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
        target,
        rawArgs: args,
        normalizedTokens,
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

function parseSupportedRunTarget(tokens: string[]): SupportedTarget | null {
  if (tokens.length === 1) {
    switch (tokens[0]) {
      case "default":
      case "local":
      case "local-01":
      case "fake-local":
      case "fake-local-01":
        return tokens[0];
      default:
        return null;
    }
  }

  if (tokens.length === 2 && tokens[0] === "fake") {
    if (tokens[1] === "local") {
      return "fake-local";
    }

    if (tokens[1] === "local-01") {
      return "fake-local-01";
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

  if (targetTokens[0] === "production" || targetTokens[0] === "production-01") {
    return {
      target: "production-01",
      artifactSelectors,
    };
  }

  return null;
}
