import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createDiagnostic } from "../diagnostics";
import type { Diagnostic } from "../types";

export interface ChallengeRequirement {
  targetName: string;
  suffix: string;
  phrase: string;
  reason: string;
}

export interface ChallengeGuardResult {
  passed: boolean;
  diagnostics: Diagnostic[];
  requirement: ChallengeRequirement | null;
}

export interface DeployGuardMetadata {
  requireChallenge?: boolean;
  reason?: string;
}

const LOCAL_TARGETS = new Set([
  "local",
  "local-01",
  "fake-local",
  "fake-local-01",
  "default",
]);

export function generateChallengeSuffix(): string {
  return String(Math.floor(100 + Math.random() * 900));
}

export function buildChallengeRequirement(
  targetName: string,
  guardMetadata: DeployGuardMetadata | null,
): ChallengeRequirement | null {
  if (LOCAL_TARGETS.has(targetName)) {
    return null;
  }

  if (guardMetadata && guardMetadata.requireChallenge === false) {
    return null;
  }

  const suffix = generateChallengeSuffix();
  const shortTarget = targetName.replace(/-01$/, "");
  const phrase = `${shortTarget}-${suffix}`;
  const reason =
    guardMetadata?.reason ??
    `Deploy target "${targetName}" requires manual confirmation.`;

  return { targetName, suffix, phrase, reason };
}

export function buildChallengeFromResolvedModel(
  resolvedModel: Record<string, unknown>,
  resolvedTarget: string,
): ChallengeRequirement | null {
  const deployGuard = extractDeployGuard(resolvedModel);
  return buildChallengeRequirement(resolvedTarget, deployGuard);
}

function extractDeployGuard(
  resolvedModel: Record<string, unknown>,
): DeployGuardMetadata | null {
  const guard = resolvedModel["DeployGuard"] ?? resolvedModel["deployGuard"];
  if (typeof guard === "object" && guard !== null && !Array.isArray(guard)) {
    const g = guard as Record<string, unknown>;
    return {
      requireChallenge:
        typeof g["requireChallenge"] === "boolean"
          ? g["requireChallenge"]
          : typeof g["RequireChallenge"] === "boolean"
            ? g["RequireChallenge"]
            : undefined,
      reason:
        typeof g["reason"] === "string"
          ? g["reason"]
          : typeof g["Reason"] === "string"
            ? (g["Reason"] as string)
            : undefined,
    };
  }

  if (guard === true) {
    return { requireChallenge: true };
  }

  return null;
}

export async function executeCliChallenge(
  requirement: ChallengeRequirement,
): Promise<ChallengeGuardResult> {
  const diagnostics: Diagnostic[] = [];

  if (!process.stdin.isTTY) {
    diagnostics.push(
      createDiagnostic(
        "error",
        "challenge-non-interactive",
        `Deploy to "${requirement.targetName}" requires interactive confirmation but stdin is not a TTY. ` +
          `Cannot proceed in non-interactive mode.`,
      ),
    );
    return { passed: false, diagnostics, requirement };
  }

  process.stdout.write(
    `\n  ╭─────────────────────────────────────────────╮\n` +
      `  │  Deploy Guard — manual confirmation required │\n` +
      `  ╰─────────────────────────────────────────────╯\n\n` +
      `  ${requirement.reason}\n\n` +
      `  Type "${requirement.phrase}" to continue: `,
  );

  const answer = await readLineFromStreams();
  const trimmed = answer.trim();

  if (trimmed === requirement.phrase) {
    diagnostics.push(
      createDiagnostic(
        "info",
        "challenge-passed",
        `Challenge confirmed for target "${requirement.targetName}".`,
      ),
    );
    return { passed: true, diagnostics, requirement };
  }

  diagnostics.push(
    createDiagnostic(
      "error",
      "challenge-failed",
      `Challenge response "${trimmed}" does not match expected "${requirement.phrase}". Deploy aborted.`,
    ),
  );
  return { passed: false, diagnostics, requirement };
}

export function buildWebUiChallengePayload(
  requirement: ChallengeRequirement,
): Record<string, unknown> {
  return {
    type: "deploy-challenge",
    targetName: requirement.targetName,
    phrase: requirement.phrase,
    reason: requirement.reason,
    instructions: `Type "${requirement.phrase}" to confirm deployment to "${requirement.targetName}".`,
  };
}

export function validateWebUiChallengeResponse(
  requirement: ChallengeRequirement,
  response: string,
): ChallengeGuardResult {
  const diagnostics: Diagnostic[] = [];
  const trimmed = response.trim();

  if (trimmed === requirement.phrase) {
    diagnostics.push(
      createDiagnostic(
        "info",
        "challenge-passed",
        `Challenge confirmed for target "${requirement.targetName}".`,
      ),
    );
    return { passed: true, diagnostics, requirement };
  }

  diagnostics.push(
    createDiagnostic(
      "error",
      "challenge-failed",
      `Challenge response "${trimmed}" does not match expected "${requirement.phrase}". Deploy aborted.`,
    ),
  );
  return { passed: false, diagnostics, requirement };
}

export function readLineFromStreams(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input,
      output,
    });
    let settled = false;

    const settle = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    rl.once("line", (line) => {
      settle(line);
      rl.close();
    });
    rl.once("close", () => {
      settle("");
    });
  });
}
