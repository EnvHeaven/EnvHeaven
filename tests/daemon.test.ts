import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startDaemon } from "../src/daemon/server";

const fixturesRoot = path.join(__dirname, "fixtures");

test("serves discovery, plugin status, and plan endpoints", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-basic");
  const server = await startDaemon(repoRoot, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    const discoveryResponse = await fetch(`http://127.0.0.1:${port}/repo/discovery`);
    const pluginResponse = await fetch(`http://127.0.0.1:${port}/plugin/status`);
    const planResponse = await fetch(`http://127.0.0.1:${port}/plans/local`);

    assert.equal(rootResponse.status, 200);
    assert.equal(discoveryResponse.status, 200);
    assert.equal(pluginResponse.status, 200);
    assert.equal(planResponse.status, 200);

    const rootPayload = await rootResponse.text();
    const discoveryPayload = (await discoveryResponse.json()) as { files: unknown[] };
    const pluginPayload = (await pluginResponse.json()) as { targets: unknown[] };
    const planPayload = (await planResponse.json()) as { requestedTarget: string; resolvedTarget: string; diagnostics: unknown[] };

    assert.match(rootPayload, /EnvHeaven Daemon/);
    assert.match(rootPayload, /\/repo\/discovery/);
    assert.equal(discoveryPayload.files.length > 0, true);
    assert.equal(pluginPayload.targets.length, 5);
    assert.equal(planPayload.requestedTarget, "local");
    assert.equal(planPayload.resolvedTarget, "local-01");
    assert.equal(Array.isArray(planPayload.diagnostics), true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("serves status, repo list, and version registry endpoints", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-deploy");
  const server = await startDaemon(repoRoot, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
    const reposResponse = await fetch(`http://127.0.0.1:${port}/api/repos`);
    const versionsResponse = await fetch(`http://127.0.0.1:${port}/api/versions`);

    assert.equal(statusResponse.status, 200);
    assert.equal(reposResponse.status, 200);
    assert.equal(versionsResponse.status, 200);

    const statusPayload = (await statusResponse.json()) as { ok: boolean; commands: string[] };
    const reposPayload = (await reposResponse.json()) as { repos: Array<{ repoRoot: string }> };
    const versionsPayload = (await versionsResponse.json()) as { versions: Array<{ artifactName: string }> };

    assert.equal(statusPayload.ok, true);
    assert.ok(statusPayload.commands.includes("envheaven offiline-web-ui"));
    assert.ok(statusPayload.commands.includes("envheaven deploy development"));
    assert.ok(statusPayload.commands.includes("envheaven deploy beta"));
    assert.ok(reposPayload.repos.some((repo) => repo.repoRoot === repoRoot));
    assert.ok(
      versionsPayload.versions.some((entry) => entry.artifactName === "envheaven-plugin-offiline-web-ui-01"),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("publishes websocket events for repo selection and version updates", async () => {
  const repoRoot = path.join(fixturesRoot, "repo-deploy");
  const nextRepoRoot = path.join(fixturesRoot, "repo-basic");
  const server = await startDaemon(repoRoot, 0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: Array<Record<string, unknown>> = [];

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
    });

    socket.addEventListener("message", (event) => {
      events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    const selectResponse = await fetch(`http://127.0.0.1:${port}/api/repos/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: nextRepoRoot }),
    });
    assert.equal(selectResponse.status, 200);

    const setResponse = await fetch(`http://127.0.0.1:${port}/api/versions/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifactName: "envheaven-plugin-offiline-web-ui-01",
        nextVersion: "1.2.3",
      }),
    });
    assert.equal(setResponse.status, 200);

    await waitFor(() => events.length >= 2);

    assert.equal(events[0]?.type, "repo:selected");
    assert.equal(events[1]?.type, "version:set");
  } finally {
    socket.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out while waiting for daemon websocket events.");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
