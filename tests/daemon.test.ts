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
    const discoveryResponse = await fetch(`http://127.0.0.1:${port}/repo/discovery`);
    const pluginResponse = await fetch(`http://127.0.0.1:${port}/plugin/status`);
    const planResponse = await fetch(`http://127.0.0.1:${port}/plans/local`);

    assert.equal(discoveryResponse.status, 200);
    assert.equal(pluginResponse.status, 200);
    assert.equal(planResponse.status, 200);

    const discoveryPayload = (await discoveryResponse.json()) as { files: unknown[] };
    const pluginPayload = (await pluginResponse.json()) as { targets: unknown[] };
    const planPayload = (await planResponse.json()) as { requestedTarget: string; resolvedTarget: string; diagnostics: unknown[] };

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
