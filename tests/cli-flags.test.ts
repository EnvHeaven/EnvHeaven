import test from "node:test";
import assert from "node:assert/strict";
import { parseGlobalFlags } from "../src/cli-flags";

test("no flags: all options false, all args remain", () => {
  const result = parseGlobalFlags(["run", "local"]);
  assert.equal(result.options.version, false);
  assert.equal(result.options.verbose, false);
  assert.equal(result.options.jsonRequest, false);
  assert.equal(result.options.jsonResponse, false);
  assert.deepEqual(result.remainingArgs, ["run", "local"]);
});

test("--version sets version and is stripped", () => {
  const result = parseGlobalFlags(["--version"]);
  assert.equal(result.options.version, true);
  assert.deepEqual(result.remainingArgs, []);
});

test("--v sets version and is stripped", () => {
  const result = parseGlobalFlags(["--v"]);
  assert.equal(result.options.version, true);
  assert.deepEqual(result.remainingArgs, []);
});

test("-version sets version and is stripped", () => {
  const result = parseGlobalFlags(["-version"]);
  assert.equal(result.options.version, true);
  assert.deepEqual(result.remainingArgs, []);
});

test("-v sets version and is stripped", () => {
  const result = parseGlobalFlags(["-v"]);
  assert.equal(result.options.version, true);
  assert.deepEqual(result.remainingArgs, []);
});

test("--verbose sets verbose and is stripped, positional args remain", () => {
  const result = parseGlobalFlags(["--verbose", "run", "local"]);
  assert.equal(result.options.verbose, true);
  assert.deepEqual(result.remainingArgs, ["run", "local"]);
});

test("--verbose=true sets verbose and is stripped", () => {
  const result = parseGlobalFlags(["--verbose=true"]);
  assert.equal(result.options.verbose, true);
  assert.deepEqual(result.remainingArgs, []);
});

test("--json sets both jsonRequest and jsonResponse", () => {
  const result = parseGlobalFlags(["--json"]);
  assert.equal(result.options.jsonRequest, true);
  assert.equal(result.options.jsonResponse, true);
});

test("--json=true sets both jsonRequest and jsonResponse", () => {
  const result = parseGlobalFlags(["--json=true"]);
  assert.equal(result.options.jsonRequest, true);
  assert.equal(result.options.jsonResponse, true);
});

test("--json-request sets only jsonRequest", () => {
  const result = parseGlobalFlags(["--json-request"]);
  assert.equal(result.options.jsonRequest, true);
  assert.equal(result.options.jsonResponse, false);
});

test("--json-request=true sets only jsonRequest", () => {
  const result = parseGlobalFlags(["--json-request=true"]);
  assert.equal(result.options.jsonRequest, true);
  assert.equal(result.options.jsonResponse, false);
});

test("--json-response sets only jsonResponse", () => {
  const result = parseGlobalFlags(["--json-response"]);
  assert.equal(result.options.jsonRequest, false);
  assert.equal(result.options.jsonResponse, true);
});

test("--json-response=true sets only jsonResponse", () => {
  const result = parseGlobalFlags(["--json-response=true"]);
  assert.equal(result.options.jsonRequest, false);
  assert.equal(result.options.jsonResponse, true);
});

test("multiple flags combined with positional args", () => {
  const result = parseGlobalFlags(["--verbose", "--json-response", "run", "local"]);
  assert.equal(result.options.verbose, true);
  assert.equal(result.options.jsonResponse, true);
  assert.equal(result.options.jsonRequest, false);
  assert.equal(result.options.version, false);
  assert.deepEqual(result.remainingArgs, ["run", "local"]);
});
