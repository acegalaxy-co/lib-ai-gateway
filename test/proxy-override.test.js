"use strict";

// commons/ai-gateway/test/proxy-override.test.js
// Run: npm test (uses node --test). Build dist/ first (npm run build).
//
// Covers commons/ai-gateway/lib/proxy-override/ — single layer resolving
// "original API vs proxy (9router)" endpoint + model-id prefix for ALL
// dispatchCall paths (tier binding, modelOverride, env-override) uniformly.
// Regression guard: the exact PROD bug (modelOverride bypassed 9router
// routing for DeepSeek → L1_provider_unavailable).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const ENV_KEYS = [
  "NEXUS_CLAUDE_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "NEXUS_CODEX_BASE_URL",
  "NEXUS_DEEPSEEK_BASE_URL",
  "NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE",
  "NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE",
  "NEXUS_9ROUTER_BASE_URL",
  "NEXUS_9ROUTER_TOKEN",
];

function _clean() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function _snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function _restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function _load() {
  return require(path.join(DIST, "lib", "proxy-override", "index.js"));
}

test("1. original, no env: anthropic bare model untouched", () => {
  const snap = _snapshotEnv();
  _clean();
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({ provider: "anthropic-api", model: "claude-sonnet-4-6" });
    assert.equal(r.model, "claude-sonnet-4-6");
    assert.equal(r.baseUrl, undefined);
    assert.equal(r.apiKeyEnv, undefined);
  } finally {
    _restoreEnv(snap);
  }
});

test("2. deepseek 9router flag=1: ds/ prefix + 9router baseUrl + token", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-token";
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({
      provider: "deepseek-api",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "NEXUS_DEEPSEEK_API_KEY",
    });
    assert.equal(r.model, "ds/deepseek-v4-pro");
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
  } finally {
    _restoreEnv(snap);
  }
});

test("3. REGRESSION GUARD — modelOverride path (provider openai-compat) for deepseek still routes via 9router", () => {
  // Repro of the exact PROD bug: src/app/llm/client.ts passes modelOverride
  // with provider:"openai-compat" (not "deepseek-api") for DeepSeek. Family
  // detection must fall back to bareModel.startsWith("deepseek") so this
  // path is NOT silently skipped as non-family.
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-token";
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({
      provider: "openai-compat",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "NEXUS_DEEPSEEK_API_KEY",
    });
    assert.equal(r.model, "ds/deepseek-v4-pro");
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
  } finally {
    _restoreEnv(snap);
  }
});

test("4. anthropic proxy: NEXUS_CLAUDE_BASE_URL=9router gets cc/ prefix", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_CLAUDE_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({ provider: "anthropic-cli", model: "claude-sonnet-4-6" });
    assert.equal(r.model, "cc/claude-sonnet-4-6");
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
  } finally {
    _restoreEnv(snap);
  }
});

test("5. anthropic original: api.anthropic.com baseUrl keeps bare model", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_CLAUDE_BASE_URL = "https://api.anthropic.com";
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({ provider: "anthropic-api", model: "claude-sonnet-4-6" });
    assert.equal(r.model, "claude-sonnet-4-6");
    assert.equal(r.baseUrl, "https://api.anthropic.com");
  } finally {
    _restoreEnv(snap);
  }
});

test("6. codex 9router flag=1: cx/ prefix + 9router baseUrl + token", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-token";
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({ provider: "codex-cli", model: "gpt-5.5" });
    assert.equal(r.model, "cx/gpt-5.5");
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
  } finally {
    _restoreEnv(snap);
  }
});

test("7. idempotent: re-applying to an already-prefixed model does not double-prefix", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_CLAUDE_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const { applyProxyOverride } = _load();
    const r1 = applyProxyOverride({ provider: "anthropic-cli", model: "claude-sonnet-4-6" });
    const r2 = applyProxyOverride({ provider: "anthropic-cli", model: r1.model, baseUrl: r1.baseUrl, apiKeyEnv: r1.apiKeyEnv });
    assert.equal(r2.model, r1.model);
    assert.equal((r2.model.match(/cc\//g) || []).length, 1, `double-prefixed: ${r2.model}`);
  } finally {
    _restoreEnv(snap);
  }
});

test("8. non-family provider untouched (gemini-cli), original unstripped model returned", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-token";
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({
      provider: "gemini-cli",
      model: "ds/gemini-2.5-pro",
      baseUrl: "https://example.com",
      apiKeyEnv: "SOME_ENV",
    });
    // Non-family: returned verbatim, including the unstripped prefix-looking string.
    assert.equal(r.model, "ds/gemini-2.5-pro");
    assert.equal(r.baseUrl, "https://example.com");
    assert.equal(r.apiKeyEnv, "SOME_ENV");
  } finally {
    _restoreEnv(snap);
  }
});

test("9. multi-proxy host coverage: alternate proxy host (9router2) is NOT treated as original", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.NEXUS_DEEPSEEK_BASE_URL = "https://9router2.acegalaxy.co/v1";
  try {
    const { applyProxyOverride } = _load();
    const r = applyProxyOverride({
      provider: "deepseek-api",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "NEXUS_DEEPSEEK_API_KEY",
    });
    assert.equal(r.model, "ds/deepseek-v4-pro");
    assert.equal(r.baseUrl, "https://9router2.acegalaxy.co/v1");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN", "9router-family host must switch key env even for alternate host");
  } finally {
    _restoreEnv(snap);
  }
});
