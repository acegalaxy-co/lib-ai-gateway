"use strict";

// v2.0.0 BREAKING: legacy NEXUS_* env names are no longer read (no fallback).
// Run: npm test (build dist/ first).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");

const LEGACY = {
  NEXUS_9ROUTER_BASE_URL: "https://legacy.example.com/v1",
  NEXUS_9ROUTER_TOKEN: "legacy-token",
  NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE: "1",
  NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE: "1",
  NEXUS_CLAUDE_BASE_URL: "https://legacy.example.com/v1",
  NEXUS_DEEPSEEK_BASE_URL: "https://legacy.example.com/v1",
  NEXUS_CODEX_BASE_URL: "https://legacy.example.com/v1",
  NEXUS_ANTHROPIC_API_KEY: "legacy-key",
  NEXUS_AI_GATEWAY_MODEL_DEFAULT: "legacy-model",
  NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT: "-100legacy",
};
const CLEAR = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AI_GATEWAY_MODEL_DEFAULT", "TELEGRAM_CHANNEL_STATUS_ALERT_ID"];

function withEnv(fn) {
  const keys = [...Object.keys(LEGACY), ...CLEAR];
  const snap = {};
  for (const k of keys) { snap[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, LEGACY);
  const restore = () => {
    for (const k of keys) {
      if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k];
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

test("legacy NEXUS_9ROUTER_* / NEXUS_*_BASE_URL no longer trigger proxy override", () =>
  withEnv(() => {
    const { applyProxyOverride } = require(path.join(DIST, "lib", "proxy-override", "index.js"));
    for (const p of [
      { provider: "deepseek-api", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY_NEXUS" },
      { provider: "codex-cli", model: "gpt-5" },
      { provider: "anthropic-api", model: "claude-sonnet-4-6" },
    ]) {
      const r = applyProxyOverride(p);
      assert.equal(r.model, p.model, "model must not get a proxy prefix");
      assert.equal(r.baseUrl, undefined);
      assert.equal(r.apiKeyEnv, p.apiKeyEnv);
    }
  }));

test("legacy NEXUS_ANTHROPIC_API_KEY is not read as fallback key", () =>
  withEnv(async () => {
    const src = require("node:fs").readFileSync(path.join(DIST, "adapters", "api-key", "anthropic-api.js"), "utf8");
    assert.ok(!src.includes("NEXUS_"), "dist adapter must not reference NEXUS_*");
  }));

test("legacy NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT does not enable claude-limit alert", () =>
  withEnv(async () => {
    const { alertClaudeCliLimit, _clearAlertCooldown } = require(path.join(DIST, "lib", "claude-limit", "alert.js"));
    _clearAlertCooldown("legacy-sched", "session_5h");
    let called = false;
    const warn = console.warn; console.warn = () => {};
    try {
      await alertClaudeCliLimit("legacy-sched", "s.k", "session_5h", Date.now(), () => { called = true; });
    } finally { console.warn = warn; }
    assert.equal(called, false, "transport must not fire with only the legacy channel env set");
  }));
