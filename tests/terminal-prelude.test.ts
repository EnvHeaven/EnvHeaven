import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPtyDisplayPrelude } from "../src/daemon/server";

describe("buildPtyDisplayPrelude", () => {
  it("formats the display-only PTY prelude with prompt colors", () => {
    const prelude = buildPtyDisplayPrelude(
      "/home/joveem/repos/example",
      "pnpm install && envheaven deploy development web-site-01-fe-01",
    );

    assert.match(prelude, /^\x1b\[32m.+@.+\x1b\[39m:\x1b\[34m\/home\/joveem\/repos\/example\x1b\[39m\$ /);
    assert.match(prelude, /pnpm install && envheaven deploy development web-site-01-fe-01\x1b\[0m\r\n$/);
  });

  it("strips terminal control characters from command text", () => {
    const prelude = buildPtyDisplayPrelude("/repo", "echo safe\x1b[31m\nnext");

    assert.match(prelude, /echo safe && next/);
    assert.doesNotMatch(prelude, /safe\x1b/);
  });
});
