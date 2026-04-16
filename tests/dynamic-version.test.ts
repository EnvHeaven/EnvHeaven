import test from "node:test";
import assert from "node:assert/strict";
import { materializeDynamicVersionExecution, materializeDynamicVersionToken } from "../src/deploy/dynamic-version";
import type { ExecutionSpec } from "../src/types";

test("materializeDynamicVersionToken resolves literal token and mixed quote function templates", () => {
  assert.equal(
    materializeDynamicVersionToken("dynamic-artifact-version", "web-app-01", "1.2.3"),
    "1.2.3",
  );
  assert.equal(
    materializeDynamicVersionToken('{{GetDynamicArtifactVersionOf("web-app-01")}}', "web-app-01", "1.2.3"),
    "1.2.3",
  );
  assert.equal(
    materializeDynamicVersionToken("v{{GetDynamicArtifactVersionOf(`web-app-01`)}}", "web-app-01", "1.2.3"),
    "v1.2.3",
  );
});

test("materializeDynamicVersionExecution resolves artifact EnvVars JSON payloads for the current artifact", () => {
  const execution: ExecutionSpec = {
    command: "node",
    args: [
      "build",
      `ENV_VARS={"EH_ARTIFACT_VERSION":"dynamic-artifact-version","PUBLIC_VERSION":"{{GetDynamicArtifactVersionOf("web-app-01")}}"}`,
    ],
    env: {
      EH_ARTIFACT_VERSION: "dynamic-artifact-version",
      PUBLIC_VERSION: "{{GetDynamicArtifactVersionOf(`web-app-01`)}}",
      OTHER_ARTIFACT_VERSION: "{{GetDynamicArtifactVersionOf('other-artifact-01')}}",
    },
    cwd: "/tmp/example",
  };

  const hydrated = materializeDynamicVersionExecution(execution, "web-app-01", "2.3.4");

  assert.equal(
    hydrated.args[1],
    'ENV_VARS={"EH_ARTIFACT_VERSION":"2.3.4","PUBLIC_VERSION":"2.3.4"}',
  );
  assert.equal(hydrated.env["EH_ARTIFACT_VERSION"], "2.3.4");
  assert.equal(hydrated.env["PUBLIC_VERSION"], "2.3.4");
  assert.equal(
    hydrated.env["OTHER_ARTIFACT_VERSION"],
    "{{GetDynamicArtifactVersionOf('other-artifact-01')}}",
  );
});
