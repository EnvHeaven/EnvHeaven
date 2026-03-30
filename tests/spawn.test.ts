import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv, resolveCommandForPlatform } from "../src/execution/spawn";

test("Windows + pnpm resolves to pnpm.cmd", () => {
  assert.equal(resolveCommandForPlatform("pnpm", "win32"), "pnpm.cmd");
});

test("Windows + npm resolves to npm.cmd", () => {
  assert.equal(resolveCommandForPlatform("npm", "win32"), "npm.cmd");
});

test("Linux + pnpm stays pnpm", () => {
  assert.equal(resolveCommandForPlatform("pnpm", "linux"), "pnpm");
});

test("Linux + npm stays npm", () => {
  assert.equal(resolveCommandForPlatform("npm", "linux"), "npm");
});

test("child process env inherits PATH correctly on Windows", () => {
  const mergedEnv = buildSpawnEnv(
    {
      Path: "C:\\Windows\\System32",
      HOME: "C:\\Users\\tester",
    },
    {
      PATH: "C:\\Tools\\pnpm",
      EH_TARGET: "local-01",
    },
    "win32",
  );

  assert.equal(mergedEnv.Path, "C:\\Tools\\pnpm");
  assert.equal(mergedEnv.PATH, undefined);
  assert.equal(mergedEnv.HOME, "C:\\Users\\tester");
  assert.equal(mergedEnv.EH_TARGET, "local-01");
});
