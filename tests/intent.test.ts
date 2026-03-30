import test from "node:test";
import assert from "node:assert/strict";
import { inferCommandIntent } from "../src/commands/intent";

const acceptedCases = [
  { args: [], kind: "daemon", target: undefined },
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
  { args: ["deploy", "production"], kind: "deploy", target: "production-01" },
  { args: ["deploy", "production-01"], kind: "deploy", target: "production-01" },
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

const rejectedCases = [
  ["run"],
  ["deploy"],
  ["deploy", "default"],
  ["deploy", "last"],
  ["run", "deploy"],
  ["run", "deploy", "local"],
  ["run", "local", "development"],
  ["deploy", "local", "development"],
  ["last"],
  ["run", "development"],
  ["development"],
];

for (const rejectedCase of rejectedCases) {
  test(`rejects ${rejectedCase.join(" ")}`, () => {
    const result = inferCommandIntent(rejectedCase);
    assert.equal(result.intent, null);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.severity === "error"));
  });
}
