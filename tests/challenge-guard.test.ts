import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  buildChallengeRequirement,
  buildChallengeFromResolvedModel,
  buildWebUiChallengePayload,
  readLineFromStreams,
  shouldUseTerminalReadline,
  validateWebUiChallengeResponse,
} from "../src/guards/challenge";

describe("buildChallengeRequirement", () => {
  it("returns null for local target", () => {
    const result = buildChallengeRequirement("local-01", null);
    assert.strictEqual(result, null);
  });

  it("returns null for default target", () => {
    const result = buildChallengeRequirement("default", null);
    assert.strictEqual(result, null);
  });

  it("returns null for fake-local target", () => {
    const result = buildChallengeRequirement("fake-local-01", null);
    assert.strictEqual(result, null);
  });

  it("returns requirement for beta-01", () => {
    const result = buildChallengeRequirement("beta-01", { requireChallenge: true });
    assert.notStrictEqual(result, null);
    assert.ok(result!.phrase.startsWith("beta-"));
    assert.strictEqual(result!.targetName, "beta-01");
    assert.strictEqual(result!.suffix.length, 3);
  });

  it("returns requirement for production-01", () => {
    const result = buildChallengeRequirement("production-01", { requireChallenge: true });
    assert.notStrictEqual(result, null);
    assert.ok(result!.phrase.startsWith("production-"));
    assert.strictEqual(result!.targetName, "production-01");
  });

  it("returns requirement for development-01 when guard metadata says so", () => {
    const result = buildChallengeRequirement("development-01", { requireChallenge: true });
    assert.notStrictEqual(result, null);
    assert.ok(result!.phrase.startsWith("development-"));
  });

  it("returns null for non-local when guard explicitly disables", () => {
    const result = buildChallengeRequirement("beta-01", { requireChallenge: false });
    assert.strictEqual(result, null);
  });

  it("uses custom reason from metadata", () => {
    const result = buildChallengeRequirement("production-01", {
      requireChallenge: true,
      reason: "Production deploy is irreversible.",
    });
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.reason, "Production deploy is irreversible.");
  });

  it("phrase contains target name and 3-digit suffix", () => {
    const result = buildChallengeRequirement("beta-01", { requireChallenge: true });
    assert.notStrictEqual(result, null);
    const parts = result!.phrase.split("-");
    const suffix = parts[parts.length - 1];
    assert.strictEqual(suffix.length, 3);
    assert.ok(/^\d{3}$/.test(suffix));
    assert.ok(result!.phrase.includes("beta"));
  });

  it("returns requirement for non-local even without guard metadata (default behavior)", () => {
    const result = buildChallengeRequirement("production-01", null);
    assert.notStrictEqual(result, null);
    assert.ok(result!.phrase.startsWith("production-"));
  });
});

describe("buildChallengeFromResolvedModel", () => {
  it("extracts DeployGuard from resolved model", () => {
    const resolvedModel = {
      DeployGuard: {
        requireChallenge: true,
        reason: "Beta deploy guard.",
      },
    };
    const result = buildChallengeFromResolvedModel(resolvedModel, "beta-01");
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.reason, "Beta deploy guard.");
  });

  it("returns null for local target even with guard in model", () => {
    const resolvedModel = {
      DeployGuard: { requireChallenge: true },
    };
    const result = buildChallengeFromResolvedModel(resolvedModel, "local-01");
    assert.strictEqual(result, null);
  });

  it("respects requireChallenge: false in model", () => {
    const resolvedModel = {
      DeployGuard: { requireChallenge: false },
    };
    const result = buildChallengeFromResolvedModel(resolvedModel, "beta-01");
    assert.strictEqual(result, null);
  });

  it("handles DeployGuard: true shorthand", () => {
    const resolvedModel = { DeployGuard: true };
    const result = buildChallengeFromResolvedModel(resolvedModel, "production-01");
    assert.notStrictEqual(result, null);
  });
});

describe("validateWebUiChallengeResponse", () => {
  it("passes when response matches phrase exactly", () => {
    const requirement = {
      targetName: "beta-01",
      suffix: "552",
      phrase: "beta-552",
      reason: "test",
    };
    const result = validateWebUiChallengeResponse(requirement, "beta-552");
    assert.strictEqual(result.passed, true);
  });

  it("fails when response does not match", () => {
    const requirement = {
      targetName: "beta-01",
      suffix: "552",
      phrase: "beta-552",
      reason: "test",
    };
    const result = validateWebUiChallengeResponse(requirement, "beta-999");
    assert.strictEqual(result.passed, false);
  });

  it("fails when response is empty", () => {
    const requirement = {
      targetName: "production-01",
      suffix: "123",
      phrase: "production-123",
      reason: "test",
    };
    const result = validateWebUiChallengeResponse(requirement, "");
    assert.strictEqual(result.passed, false);
  });

  it("trims whitespace from response", () => {
    const requirement = {
      targetName: "beta-01",
      suffix: "777",
      phrase: "beta-777",
      reason: "test",
    };
    const result = validateWebUiChallengeResponse(requirement, "  beta-777  ");
    assert.strictEqual(result.passed, true);
  });
});

describe("buildWebUiChallengePayload", () => {
  it("produces JSON-serializable payload with required fields", () => {
    const requirement = {
      targetName: "production-01",
      suffix: "321",
      phrase: "production-321",
      reason: "Deploying to production.",
    };
    const payload = buildWebUiChallengePayload(requirement);
    assert.strictEqual(payload["type"], "deploy-challenge");
    assert.strictEqual(payload["targetName"], "production-01");
    assert.strictEqual(payload["phrase"], "production-321");
    assert.strictEqual(payload["reason"], "Deploying to production.");
    assert.ok(typeof payload["instructions"] === "string");
  });
});

describe("readLineFromStreams", () => {
  it("returns the typed line instead of the close fallback", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const promise = readLineFromStreams(input, output);

    input.write("development-531\n");

    const result = await promise;
    assert.strictEqual(result, "development-531");
  });

  it("does not redraw prompt output while user edits input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";

    output.on("data", (chunk) => {
      captured += chunk.toString("utf8");
    });

    const promise = readLineFromStreams(input, output);
    input.write("development-53\b8\n");

    const result = await promise;
    assert.strictEqual(result, "development-53\b8");
    assert.strictEqual(captured, "");
  });

  it("uses terminal readline only when both streams are TTYs", () => {
    const ttyInput = new PassThrough() as PassThrough & { isTTY?: boolean };
    const ttyOutput = new PassThrough() as PassThrough & { isTTY?: boolean };
    const pipeInput = new PassThrough();
    const pipeOutput = new PassThrough();

    ttyInput.isTTY = true;
    ttyOutput.isTTY = true;

    assert.strictEqual(shouldUseTerminalReadline(ttyInput, ttyOutput), true);
    assert.strictEqual(shouldUseTerminalReadline(ttyInput, pipeOutput), false);
    assert.strictEqual(shouldUseTerminalReadline(pipeInput, ttyOutput), false);
    assert.strictEqual(shouldUseTerminalReadline(pipeInput, pipeOutput), false);
  });
});
