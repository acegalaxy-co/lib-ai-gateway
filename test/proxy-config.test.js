"use strict";

// commons/ai-gateway/test/proxy-config.test.js
// Run: npm test (uses node --test). Build dist/ first (npm run build).
//
// Covers config-driven proxy routing (config/proxy.json) added 2026-07-19:
// - a 4th family can be added purely via fixture config, no code change
// - .env override still resolves per-family baseUrlEnv
// - malformed/missing AI_GATEWAY_PROXY_CONFIG falls back to DEFAULT_CONFIG,
//   never throws
// - lib/env isLocalEndpoint() reads the same config's localDetect block

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const ENV_KEYS = [
  "AI_GATEWAY_PROXY_CONFIG",
  "NEXUS_CLAUDE_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "QWEN_BASE_URL",
  "LOCAL_SERVICE_MODE",
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

function _loadProxyOverride() {
  return require(path.join(DIST, "lib", "proxy-override", "index.js"));
}

function _loadEnv() {
  return require(path.join(DIST, "lib", "env", "index.js"));
}

// require() caches dist modules across tests — clear so each test picks up
// the fresh env/config state (proxy-override module itself also caches
// _config internally; _resetConfigCache() clears that layer).
function _clearRequireCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST + path.sep)) delete require.cache[key];
  }
}

function _writeFixture(obj) {
  const p = path.join(os.tmpdir(), `ai-gateway-proxy-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}

const DEFAULT_FIXTURE = {
  proxy: { baseUrlEnv: "NEXUS_9ROUTER_BASE_URL", tokenEnv: "NEXUS_9ROUTER_TOKEN", hostPattern: "9router" },
  families: {
    anthropic: {
      prefix: "cc/",
      originalHosts: ["api.anthropic.com"],
      match: { providerPrefix: "anthropic", modelPrefix: "claude" },
      baseUrlEnv: ["NEXUS_CLAUDE_BASE_URL", "ANTHROPIC_BASE_URL"],
      proxyEnableEnv: null,
      switchTokenOnProxyHost: false,
    },
    deepseek: {
      prefix: "ds/",
      originalHosts: ["api.deepseek.com"],
      match: { provider: "deepseek-api", modelPrefix: "deepseek" },
      baseUrlEnv: ["NEXUS_DEEPSEEK_BASE_URL"],
      proxyEnableEnv: "NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE",
      switchTokenOnProxyHost: true,
    },
    codex: {
      prefix: "cx/",
      originalHosts: ["api.openai.com"],
      match: { provider: "codex-cli" },
      baseUrlEnv: ["NEXUS_CODEX_BASE_URL"],
      proxyEnableEnv: "NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE",
      switchTokenOnProxyHost: false,
    },
    qwen: {
      prefix: "qw/",
      originalHosts: ["api.qwen.com"],
      match: { provider: "qwen-api", modelPrefix: "qwen" },
      baseUrlEnv: ["QWEN_BASE_URL"],
      proxyEnableEnv: null,
      switchTokenOnProxyHost: false,
    },
  },
  localDetect: { baseUrlEnv: "ANTHROPIC_BASE_URL", forceLocalEnv: "LOCAL_SERVICE_MODE" },
};

test("1. new family added purely via config fixture (no code change): qwen gets qw/ prefix on proxy host", () => {
  const snap = _snapshotEnv();
  _clean();
  const fixturePath = _writeFixture(DEFAULT_FIXTURE);
  process.env.AI_GATEWAY_PROXY_CONFIG = fixturePath;
  try {
    const { applyProxyOverride, _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
    const r = applyProxyOverride({
      provider: "qwen-api",
      model: "qwen-max",
      baseUrl: "https://proxy.example.com",
    });
    assert.equal(r.model, "qw/qwen-max", "non-original host must get qw/ prefix");
  } finally {
    fs.unlinkSync(fixturePath);
    _restoreEnv(snap);
    const { _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
  }
});

test("2. .env override resolves per-family baseUrlEnv from fixture config", () => {
  const snap = _snapshotEnv();
  _clean();
  const fixturePath = _writeFixture(DEFAULT_FIXTURE);
  process.env.AI_GATEWAY_PROXY_CONFIG = fixturePath;
  process.env.NEXUS_CLAUDE_BASE_URL = "https://9router.example.com/v1";
  try {
    const { applyProxyOverride, _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
    const r = applyProxyOverride({ provider: "anthropic-cli", model: "claude-sonnet-4-6" });
    assert.equal(r.baseUrl, "https://9router.example.com/v1", "baseUrl must be overridden by NEXUS_CLAUDE_BASE_URL");
    assert.equal(r.model, "cc/claude-sonnet-4-6");
  } finally {
    fs.unlinkSync(fixturePath);
    _restoreEnv(snap);
    const { _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
  }
});

test("3. AI_GATEWAY_PROXY_CONFIG points at nonexistent path: falls back to default config, does not throw", () => {
  const snap = _snapshotEnv();
  _clean();
  process.env.AI_GATEWAY_PROXY_CONFIG = path.join(os.tmpdir(), "does-not-exist-ai-gateway-proxy.json");
  try {
    const { applyProxyOverride, _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
    let r;
    assert.doesNotThrow(() => {
      r = applyProxyOverride({ provider: "anthropic-cli", model: "claude-sonnet-4-6" });
    });
    assert.equal(r.model, "claude-sonnet-4-6", "default config, no proxy env set → bare model untouched");
  } finally {
    _restoreEnv(snap);
    const { _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
  }
});

test("4. lib/env isLocalEndpoint() reads localDetect from fixture config", () => {
  const snap = _snapshotEnv();
  _clean();
  const fixturePath = _writeFixture(DEFAULT_FIXTURE);
  process.env.AI_GATEWAY_PROXY_CONFIG = fixturePath;
  process.env.LOCAL_SERVICE_MODE = "1";
  try {
    _clearRequireCache();
    const { _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
    const { isLocalEndpoint } = _loadEnv();
    assert.equal(isLocalEndpoint(), true, "LOCAL_SERVICE_MODE=1 via fixture localDetect.forceLocalEnv must be LOCAL");
  } finally {
    fs.unlinkSync(fixturePath);
    _restoreEnv(snap);
    _clearRequireCache();
    const { _resetConfigCache } = _loadProxyOverride();
    _resetConfigCache();
  }
});
