"use strict";

// commons/ai-gateway/test/anthropic-cli-model.test.js
// _toCliModel: normalize registry model IDs → Claude Code CLI aliases.
// CLI (`claude -p --model`) rejects full IDs ("claude-sonnet-4-6") — accepts
// only "haiku"/"sonnet"/"opus". See adapter comment + PROD incident 2026-07-19.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { _toCliModel } = require(
  path.join(__dirname, "..", "dist", "adapters", "subscription", "anthropic-cli.js")
);

test("_toCliModel: full Anthropic IDs → tier alias", () => {
  assert.equal(_toCliModel("claude-sonnet-4-6"), "sonnet");
  assert.equal(_toCliModel("claude-sonnet-5"), "sonnet");
  assert.equal(_toCliModel("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(_toCliModel("claude-opus-4-7"), "opus");
  assert.equal(_toCliModel("claude-opus-4-8"), "opus");
});

test("_toCliModel: already-alias passes through", () => {
  assert.equal(_toCliModel("sonnet"), "sonnet");
  assert.equal(_toCliModel("haiku"), "haiku");
  assert.equal(_toCliModel("opus"), "opus");
});

test("_toCliModel: case + whitespace insensitive", () => {
  assert.equal(_toCliModel("  Claude-Sonnet-4-6 "), "sonnet");
  assert.equal(_toCliModel("HAIKU"), "haiku");
});

test("_toCliModel: empty → empty (CLI subscription default)", () => {
  assert.equal(_toCliModel(""), "");
  assert.equal(_toCliModel("   "), "");
  assert.equal(_toCliModel(null), "");
  assert.equal(_toCliModel(undefined), "");
});

test("_toCliModel: non-Anthropic model passes through unchanged", () => {
  // Adapter is anthropic-cli only, but guard against accidental cross-provider
  // values — must not silently rewrite to a Claude alias.
  assert.equal(_toCliModel("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(_toCliModel("gpt-5.5"), "gpt-5.5");
});
