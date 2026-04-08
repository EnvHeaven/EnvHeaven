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
