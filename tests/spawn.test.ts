import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv, buildSpawnPlan } from "../src/execution/spawn";

test("Windows package-manager commands are wrapped through cmd.exe", () => {
  const plan = buildSpawnPlan(
    {
      command: "pnpm",
      args: ["install"],
      env: {},
      cwd: "D:\\repo",
    },
    "win32",
  );

  assert.equal(plan.command, "cmd.exe");
  assert.deepEqual(plan.args, ["/d", "/s", "/c", "pnpm install"]);
  assert.equal(plan.windowsCommandWrappingUsed, true);
});

test("Linux package-manager commands remain direct", () => {
  const plan = buildSpawnPlan(
    {
      command: "pnpm",
      args: ["install"],
      env: {},
      cwd: "/repo",
    },
    "linux",
  );

  assert.equal(plan.command, "pnpm");
  assert.deepEqual(plan.args, ["install"]);
  assert.equal(plan.windowsCommandWrappingUsed, false);
});

test("child process env inherits PATH correctly", () => {
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

test("Windows pnpm install command line is generated correctly", () => {
  const plan = buildSpawnPlan(
    {
      command: "pnpm",
      args: ["install"],
      env: {},
      cwd: "D:\\repo",
    },
    "win32",
  );

  assert.deepEqual(plan.args, ["/d", "/s", "/c", "pnpm install"]);
});

test("Windows recursive pnpm build command line is generated correctly", () => {
  const plan = buildSpawnPlan(
    {
      command: "pnpm",
      args: ["-r", "--if-present", "run", "build"],
      env: {},
      cwd: "D:\\repo",
    },
    "win32",
  );

  assert.deepEqual(plan.args, ["/d", "/s", "/c", "pnpm -r --if-present run build"]);
});

test("Windows global npm install command line is generated correctly", () => {
  const plan = buildSpawnPlan(
    {
      command: "npm",
      args: ["install", "--global", "D:\\repo path\\artifacts\\envheaven-pkg-01"],
      env: {},
      cwd: "D:\\repo",
    },
    "win32",
  );

  assert.deepEqual(plan.args, ["/d", "/s", "/c", "npm install --global \"D:\\repo path\\artifacts\\envheaven-pkg-01\""]);
});
