import { createDiagnostic } from "../diagnostics";
import type { CommandIntent, Diagnostic, SupportedTarget } from "../types";

const SUPPORTED_KEYWORDS = new Set([
  "run",
  "deploy",
  "default",
  "local",
  "local-01",
  "production-01",
  "fake",
  "fake-local",
  "fake-local-01",
]);

const HARD_REJECT_KEYWORDS = new Set(["last", "development"]);

export function inferCommandIntent(args: string[]): {
  intent: CommandIntent | null;
  diagnostics: Diagnostic[];
} {
  const normalizedTokens = args
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

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

    if (!SUPPORTED_KEYWORDS.has(token)) {
      return {
        intent: null,
        diagnostics: [
          createDiagnostic("error", "unknown-command-token", `Unknown token "${token}".`),
        ],
      };
    }
  }

  const runCount = normalizedTokens.filter((token) => token === "run").length;
  const deployCount = normalizedTokens.filter((token) => token === "deploy").length;
  if (runCount > 1) {
    return {
      intent: null,
      diagnostics: [createDiagnostic("error", "ambiguous-command", "Command contains multiple run tags.")],
    };
  }

  if (deployCount > 1) {
    return {
      intent: null,
      diagnostics: [createDiagnostic("error", "ambiguous-command", "Command contains multiple deploy tags.")],
    };
  }

  if (runCount > 0 && deployCount > 0) {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic("error", "ambiguous-command", "Command cannot mix run and deploy tags in v0.1.0."),
      ],
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

  const targetTokens = normalizedTokens.filter((token) => token !== "deploy");
  const target = parseSupportedDeployTarget(targetTokens);
  if (!target) {
    return {
      intent: null,
      diagnostics: [
        createDiagnostic(
          "error",
          "unsupported-command-shape",
          `Unsupported or ambiguous deploy target: "${targetTokens.join(" ")}".`,
        ),
      ],
    };
  }

  return {
    intent: {
      kind: "deploy",
      target,
      rawArgs: args,
      normalizedTokens,
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

function parseSupportedDeployTarget(tokens: string[]): SupportedTarget | null {
  if (tokens.length !== 1) {
    return null;
  }

  if (tokens[0] === "local-01" || tokens[0] === "production-01") {
    return tokens[0];
  }

  return null;
}
