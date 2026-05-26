import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { EnvHeavenStateStore, resolveEnvHeavenPaths } from "../src/state/store";
import type { ControlPanelPreset } from "../src/control-panel/types";

function makeIsolatedStore(): EnvHeavenStateStore {
  const stateDir = path.join(os.tmpdir(), `envheaven-control-panel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const paths = resolveEnvHeavenPaths(process.platform, {
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: stateDir,
    XDG_CACHE_HOME: stateDir,
  });
  return new EnvHeavenStateStore(paths);
}

function makePreset(overrides: Partial<ControlPanelPreset> = {}): ControlPanelPreset {
  return {
    id: "preset_01",
    repoRoot: "/tmp/repo-one",
    name: "Main control panel",
    layout: { type: "block", blockId: "terminal_01" },
    blocks: [
      {
        id: "terminal_01",
        kind: "terminal",
        title: "Deploy terminal",
        terminal: {
          slotId: "slot_01",
          expectedActionId: "deploy_local",
        },
      },
    ],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

test("control panel presets persist per repo", async () => {
  const store = makeIsolatedStore();
  const repoRoot = "/tmp/repo-one";
  const saved = await store.upsertControlPanelPreset(repoRoot, makePreset());

  assert.equal(saved.repoRoot, repoRoot);
  assert.equal(saved.name, "Main control panel");

  const presets = await store.listControlPanelPresets(repoRoot);
  assert.equal(presets.length, 1);
  assert.equal(presets[0]?.id, "preset_01");
  assert.equal(presets[0]?.blocks[0]?.terminal?.expectedActionId, "deploy_local");
});

test("control panel preset updates preserve createdAt and refresh updatedAt", async () => {
  const store = makeIsolatedStore();
  const repoRoot = "/tmp/repo-one";
  const initial = await store.upsertControlPanelPreset(repoRoot, makePreset({ createdAt: 123, updatedAt: 123 }));
  const updated = await store.upsertControlPanelPreset(repoRoot, { ...initial, name: "Renamed panel" });

  assert.equal(updated.createdAt, 123);
  assert.equal(updated.name, "Renamed panel");
  assert.ok(updated.updatedAt >= initial.updatedAt);
});

test("control panel presets can be deleted", async () => {
  const store = makeIsolatedStore();
  const repoRoot = "/tmp/repo-one";
  await store.upsertControlPanelPreset(repoRoot, makePreset());

  assert.equal(await store.deleteControlPanelPreset(repoRoot, "preset_01"), true);
  assert.equal(await store.deleteControlPanelPreset(repoRoot, "preset_01"), false);
  assert.deepEqual(await store.listControlPanelPresets(repoRoot), []);
});

test("control panel presets can be global", async () => {
  const store = makeIsolatedStore();
  const saved = await store.upsertControlPanelPreset(undefined, makePreset({
    repoRoot: undefined,
    artifactId: undefined,
    name: "Global panel",
  }));

  assert.equal(saved.repoRoot, undefined);
  assert.equal(saved.artifactId, undefined);

  const presets = await store.listControlPanelPresets();
  assert.equal(presets.length, 1);
  assert.equal(presets[0]?.name, "Global panel");

  assert.equal(await store.deleteControlPanelPreset(undefined, "preset_01"), true);
  assert.deepEqual(await store.listControlPanelPresets(), []);
});

test("unfiltered control panel preset list returns global and scoped presets", async () => {
  const store = makeIsolatedStore();
  await store.upsertControlPanelPreset(undefined, makePreset({
    id: "global_panel",
    repoRoot: undefined,
    name: "Global panel",
  }));
  await store.upsertControlPanelPreset("/tmp/repo-one", makePreset({
    id: "scoped_panel",
    repoRoot: "/tmp/repo-one",
    artifactId: "artifact-01",
    name: "Scoped panel",
  }));

  assert.deepEqual((await store.listControlPanelPresets()).map((preset) => preset.name), [
    "Global panel",
    "Scoped panel",
  ]);
  assert.deepEqual((await store.listControlPanelPresets(undefined, "artifact-01")).map((preset) => preset.name), [
    "Scoped panel",
  ]);
  assert.deepEqual((await store.listControlPanelPresets("/tmp/repo-one")).map((preset) => preset.name), [
    "Scoped panel",
  ]);
});
