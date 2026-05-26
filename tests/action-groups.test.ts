import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { startDaemon } from "../src/daemon/server";
import { EnvHeavenStateStore, resolveEnvHeavenPaths } from "../src/state/store";

function makeIsolatedStore(): EnvHeavenStateStore {
  const stateDir = path.join(os.tmpdir(), `envheaven-action-groups-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const paths = resolveEnvHeavenPaths("linux", {
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: stateDir,
    XDG_CACHE_HOME: stateDir,
  });
  return new EnvHeavenStateStore(paths);
}

async function postJson<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as T };
}

test("grouped dispatch creates multiple PTY terminal sessions and stop group terminates them", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "envheaven-group-repo-"));
  const actionDir = path.join(repoRoot, ".envheaven", "actions");
  await fs.mkdir(actionDir, { recursive: true });
  await fs.writeFile(
    path.join(actionDir, "hold.envheaven.action.json"),
    JSON.stringify({
      id: "hold",
      label: "Hold terminal",
      runCommand: `${process.execPath} -e "setInterval(()=>{}, 1000)"`,
      stopCommand: null,
      icon: "play",
      description: "Long-running test action",
      runLabel: "Run",
      stopLabel: "Stop",
      successHelpers: [],
      failHelpers: [],
      terminalMode: "pty",
    }, null, 2),
    "utf8",
  );

  const { server, killAllRuns } = await startDaemon(repoRoot, 0, makeIsolatedStore());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    const dispatch = await postJson<{
      ok: boolean;
      group: { id: string; status: string; runIds: string[] };
      runs: Array<{ runId: string; actionGroupId: string; canAttach: boolean; status: string }>;
      slotRunMap: Record<string, string>;
    }>(`${base}/api/action-groups/dispatch`, {
      repoRoot,
      label: "Test group",
      terminals: [
        { slotId: "slot-one", repoRoot, actionId: "hold", title: "T1" },
        { slotId: "slot-two", repoRoot, actionId: "hold", title: "T2" },
      ],
    });

    assert.equal(dispatch.status, 200);
    assert.equal(dispatch.body.ok, true);
    assert.equal(dispatch.body.runs.length, 2);
    assert.equal(dispatch.body.group.runIds.length, 2);
    assert.equal(dispatch.body.slotRunMap["slot-one"], dispatch.body.runs[0]?.runId);
    assert.equal(dispatch.body.runs.every((run) => run.actionGroupId === dispatch.body.group.id), true);
    assert.equal(dispatch.body.runs.every((run) => run.canAttach), true);

    const sessionsResponse = await fetch(`${base}/api/terminal-sessions?actionGroupId=${dispatch.body.group.id}`);
    const sessionsPayload = (await sessionsResponse.json()) as { sessions: Array<{ runId: string; status: string }> };
    assert.equal(sessionsResponse.status, 200);
    assert.equal(sessionsPayload.sessions.length, 2);
    assert.equal(sessionsPayload.sessions.every((session) => session.status === "running"), true);

    const stop = await postJson<{
      ok: boolean;
      stoppedSessionIds: string[];
      group?: { status: string };
    }>(`${base}/api/action-groups/${dispatch.body.group.id}/stop`, {});
    assert.equal(stop.status, 200);
    assert.equal(stop.body.ok, true);
    assert.equal(stop.body.stoppedSessionIds.length, 2);

    const groupsResponse = await fetch(`${base}/api/action-groups?repoRoot=${encodeURIComponent(repoRoot)}`);
    const groupsPayload = (await groupsResponse.json()) as { groups: Array<{ id: string; status: string }> };
    assert.equal(groupsResponse.status, 200);
    assert.equal(groupsPayload.groups.find((group) => group.id === dispatch.body.group.id)?.status, "terminated");
  } finally {
    killAllRuns();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

