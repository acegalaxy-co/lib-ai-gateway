"use strict";

// commons/ai-gateway/test/claude-limit-barrel.test.js
// Run: npm test (node --test). Build dist/ first (npm run build).
//
// Guards the Phase B `lib/claude-limit/index.ts` barrel: the package
// `exports` map exposes "./lib/claude-limit" so external consumers import ONE
// subpath instead of the 4 internal files. If a symbol is dropped from the
// barrel, external consumers break at runtime with no compile error — this
// test is the regression net.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");

function _barrel() {
  return require(path.join(DIST, "lib", "claude-limit", "index.js"));
}

test("barrel re-exports all 9 public symbols from the 4 modules", () => {
  const m = _barrel();
  const expected = [
    "detectClaudeLimit", "limitKindLabel", // detect
    "markLimitHit", "shouldSkip", "clearLimit", "getActiveLimits", // state
    "ClaudeCliLimitError", // error
    "alertClaudeCliLimit", "_clearAlertCooldown", // alert
  ];
  for (const name of expected) {
    assert.ok(name in m, `barrel missing '${name}'`);
  }
});

test("barrel functions are callable and error is a constructor", () => {
  const m = _barrel();
  assert.equal(typeof m.detectClaudeLimit, "function");
  assert.equal(typeof m.shouldSkip, "function");
  assert.equal(typeof m.ClaudeCliLimitError, "function");
  // detect returns null for benign stderr (behavior preserved post named-export).
  assert.equal(m.detectClaudeLimit("some unrelated error"), null);
  // ClaudeCliLimitError(skill, match) is throwable + carries the discriminator.
  const e = new m.ClaudeCliLimitError("x", { kind: "session_5h", resetAt: null });
  assert.equal(e.isClaudeCliLimit, true);
  assert.equal(e.skill, "x");
  assert.equal(e.kind, "session_5h");
});

test("direct deep-require of detect still works (backward compat for in-package callers)", () => {
  // anthropic-cli.ts adapter uses require(".../detect") directly — named
  // export must keep the destructure shape.
  const { detectClaudeLimit } = require(path.join(DIST, "lib", "claude-limit", "detect.js"));
  assert.equal(typeof detectClaudeLimit, "function");
});
