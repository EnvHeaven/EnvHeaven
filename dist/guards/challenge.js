"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateChallengeSuffix = generateChallengeSuffix;
exports.buildChallengeRequirement = buildChallengeRequirement;
exports.buildChallengeFromResolvedModel = buildChallengeFromResolvedModel;
exports.executeCliChallenge = executeCliChallenge;
exports.buildWebUiChallengePayload = buildWebUiChallengePayload;
exports.validateWebUiChallengeResponse = validateWebUiChallengeResponse;
exports.readLineFromStreams = readLineFromStreams;
const readline = __importStar(require("node:readline"));
const diagnostics_1 = require("../diagnostics");
const LOCAL_TARGETS = new Set([
    "local",
    "local-01",
    "fake-local",
    "fake-local-01",
    "default",
]);
function generateChallengeSuffix() {
    return String(Math.floor(100 + Math.random() * 900));
}
function buildChallengeRequirement(targetName, guardMetadata) {
    if (LOCAL_TARGETS.has(targetName)) {
        return null;
    }
    if (guardMetadata && guardMetadata.requireChallenge === false) {
        return null;
    }
    const suffix = generateChallengeSuffix();
    const shortTarget = targetName.replace(/-01$/, "");
    const phrase = `${shortTarget}-${suffix}`;
    const reason = guardMetadata?.reason ??
        `Deploy target "${targetName}" requires manual confirmation.`;
    return { targetName, suffix, phrase, reason };
}
function buildChallengeFromResolvedModel(resolvedModel, resolvedTarget) {
    const deployGuard = extractDeployGuard(resolvedModel);
    return buildChallengeRequirement(resolvedTarget, deployGuard);
}
function extractDeployGuard(resolvedModel) {
    const guard = resolvedModel["DeployGuard"] ?? resolvedModel["deployGuard"];
    if (typeof guard === "object" && guard !== null && !Array.isArray(guard)) {
        const g = guard;
        return {
            requireChallenge: typeof g["requireChallenge"] === "boolean"
                ? g["requireChallenge"]
                : typeof g["RequireChallenge"] === "boolean"
                    ? g["RequireChallenge"]
                    : undefined,
            reason: typeof g["reason"] === "string"
                ? g["reason"]
                : typeof g["Reason"] === "string"
                    ? g["Reason"]
                    : undefined,
        };
    }
    if (guard === true) {
        return { requireChallenge: true };
    }
    return null;
}
async function executeCliChallenge(requirement) {
    const diagnostics = [];
    if (!process.stdin.isTTY) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "challenge-non-interactive", `Deploy to "${requirement.targetName}" requires interactive confirmation but stdin is not a TTY. ` +
            `Cannot proceed in non-interactive mode.`));
        return { passed: false, diagnostics, requirement };
    }
    process.stdout.write(`\n  ╭─────────────────────────────────────────────╮\n` +
        `  │  Deploy Guard — manual confirmation required │\n` +
        `  ╰─────────────────────────────────────────────╯\n\n` +
        `  ${requirement.reason}\n\n` +
        `  Type "${requirement.phrase}" to continue: `);
    const answer = await readLineFromStreams();
    const trimmed = answer.trim();
    if (trimmed === requirement.phrase) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("info", "challenge-passed", `Challenge confirmed for target "${requirement.targetName}".`));
        return { passed: true, diagnostics, requirement };
    }
    diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "challenge-failed", `Challenge response "${trimmed}" does not match expected "${requirement.phrase}". Deploy aborted.`));
    return { passed: false, diagnostics, requirement };
}
function buildWebUiChallengePayload(requirement) {
    return {
        type: "deploy-challenge",
        targetName: requirement.targetName,
        phrase: requirement.phrase,
        reason: requirement.reason,
        instructions: `Type "${requirement.phrase}" to confirm deployment to "${requirement.targetName}".`,
    };
}
function validateWebUiChallengeResponse(requirement, response) {
    const diagnostics = [];
    const trimmed = response.trim();
    if (trimmed === requirement.phrase) {
        diagnostics.push((0, diagnostics_1.createDiagnostic)("info", "challenge-passed", `Challenge confirmed for target "${requirement.targetName}".`));
        return { passed: true, diagnostics, requirement };
    }
    diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "challenge-failed", `Challenge response "${trimmed}" does not match expected "${requirement.phrase}". Deploy aborted.`));
    return { passed: false, diagnostics, requirement };
}
function readLineFromStreams(input = process.stdin, output = process.stdout) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input,
            output,
        });
        let settled = false;
        const settle = (value) => {
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
