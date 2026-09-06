import { test } from "node:test";
import assert from "node:assert/strict";
import { childEnv } from "../src/orchestrator/env.js";

test("childEnv: strips npm lifecycle variables and the Claude Code nesting guard, keeps the rest, applies extras", () => {
  const saved = { ...process.env };
  try {
    process.env.npm_config_local_prefix = "/somewhere/mendophyte";
    process.env.npm_package_json = "/somewhere/mendophyte/package.json";
    process.env.npm_lifecycle_event = "start";
    process.env.INIT_CWD = "/somewhere/mendophyte";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_CHILD_SESSION = "1";
    process.env.KEEP_ME = "yes";
    const env = childEnv({ EXTRA: "x", GONE: undefined });
    for (const k of Object.keys(env)) assert.doesNotMatch(k, /^npm_/i);
    assert.equal(env.INIT_CWD, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
    assert.equal(env.KEEP_ME, "yes");
    assert.equal(env.EXTRA, "x");
    assert.equal("GONE" in env, false);
    // process.env is case-insensitive on Windows (the real key is "Path"); a plain object is not
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH")!;
    assert.equal(env[pathKey], process.env[pathKey]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
