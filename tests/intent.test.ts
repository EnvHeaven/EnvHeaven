import test from "node:test";
import assert from "node:assert/strict";
import { inferCommandIntent } from "../src/commands/intent";
import { parseGlobalFlags } from "../src/cli-flags";

const acceptedCases = [
  { args: [], kind: "daemon", target: undefined },
  { args: ["offiline-web-ui"], kind: "offiline-web-ui", target: undefined },
  { args: ["offline-web-ui"], kind: "offiline-web-ui", target: undefined },
  { args: ["run", "local"], kind: "run", target: "local" },
  { args: ["local", "run"], kind: "run", target: "local" },
  { args: ["run", "local-01"], kind: "run", target: "local-01" },
  { args: ["run", "fake-local-01"], kind: "run", target: "fake-local-01" },
  { args: ["run", "fake", "local"], kind: "run", target: "fake-local" },
  { args: ["run", "fake", "local-01"], kind: "run", target: "fake-local-01" },
  { args: ["run", "default"], kind: "run", target: "default" },
  { args: ["default"], kind: "run", target: "default" },
  { args: ["deploy", "local"], kind: "deploy", target: "local-01" },
  { args: ["deploy", "local-01"], kind: "deploy", target: "local-01" },
  { args: ["deploy", "development"], kind: "deploy", target: "development-01" },
  { args: ["deploy", "development-01"], kind: "deploy", target: "development-01" },
  { args: ["deploy", "beta"], kind: "deploy", target: "beta-01" },
  { args: ["deploy", "beta-01"], kind: "deploy", target: "beta-01" },
  { args: ["deploy", "production"], kind: "deploy", target: "production-01" },
  { args: ["deploy", "production-01"], kind: "deploy", target: "production-01" },
  { args: ["deploy", "production", "@envheaven/plugins-nodejs-pnpm"], kind: "deploy", target: "production-01" },
  { args: ["deploy", "local", "envheaven"], kind: "deploy", target: "local-01" },
  { args: ["run", "local", "web-app-cdn-01"], kind: "run", target: "local" },
  { args: ["run", "web-app-cdn-01", "local"], kind: "run", target: "local" },
];

for (const acceptedCase of acceptedCases) {
  test(`accepts ${acceptedCase.args.join(" ") || "<empty>"}`, () => {
    const result = inferCommandIntent(acceptedCase.args);
    assert.equal(result.diagnostics.length, 0);
    assert.ok(result.intent);
    assert.equal(result.intent?.kind, acceptedCase.kind);
    assert.equal(result.intent?.target, acceptedCase.target);
  });
}

test("captures deploy artifact selectors without changing target resolution", () => {
  const result = inferCommandIntent(["deploy", "production", "@envheaven/plugins-nodejs-pnpm"]);
  assert.deepEqual(result.intent?.artifactSelectors, ["@envheaven/plugins-nodejs-pnpm"]);
});

test("captures run artifact selectors without changing target resolution", () => {
  const result = inferCommandIntent(["run", "local", "web-app-cdn-01"]);
  assert.deepEqual(result.intent?.artifactSelectors, ["web-app-cdn-01"]);
});

const rejectedCases = [
  ["run"],
  ["deploy"],
  ["deploy", "default"],
  ["offiline-web-ui", "extra"],
  ["deploy", "last"],
  ["run", "deploy"],
  ["run", "deploy", "local"],
  ["last"],
  ["development"],
];

for (const rejectedCase of rejectedCases) {
  test(`rejects ${rejectedCase.join(" ")}`, () => {
    const result = inferCommandIntent(rejectedCase);
    assert.equal(result.intent, null);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
  });
}

test("global flag --verbose before run local is stripped before intent parsing", () => {
  const { remainingArgs } = parseGlobalFlags(["--verbose", "run", "local"]);
  const result = inferCommandIntent(remainingArgs);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.intent?.kind, "run");
  assert.equal(result.intent?.target, "local");
});

test("global flag --json-response between run and local is stripped before intent parsing", () => {
  const { remainingArgs } = parseGlobalFlags(["run", "--json-response", "local"]);
  const result = inferCommandIntent(remainingArgs);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.intent?.kind, "run");
  assert.equal(result.intent?.target, "local");
});

test("global flag --json before deploy production is stripped before intent parsing", () => {
  const { remainingArgs } = parseGlobalFlags(["--json", "deploy", "production"]);
  const result = inferCommandIntent(remainingArgs);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.intent?.kind, "deploy");
  assert.equal(result.intent?.target, "production-01");
});
