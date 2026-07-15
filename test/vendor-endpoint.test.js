"use strict";

// commons/ai-gateway/test/vendor-endpoint.test.js
// Run: npm test (uses node --test). Build dist/ first (npm run build).
//
// Covers per-vendor LLM endpoint switch added 2026-07-10:
//   NEXUS_CLAUDE_BASE_URL / NEXUS_CODEX_BASE_URL / NEXUS_DEEPSEEK_BASE_URL.
//   Empty/unset = direct/original API. Non-empty = engine.check() resolves
//   that value into CheckResult.baseUrl, and (Anthropic only) drives the
//   'cc/' model-id prefix normalization. Gemini is OAuth account-based — no
//   endpoint hook, not covered here (documented N/A in .env.example).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

const ANTHROPIC_SKILL = "invoice-enrich.classify";
const ANTHROPIC_TIER = "balanced";

const VENDOR_ENV_KEYS = [
  "NEXUS_CLAUDE_BASE_URL",
  "NEXUS_CODEX_BASE_URL",
  "NEXUS_DEEPSEEK_BASE_URL",
  "NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE",
  "NEXUS_9ROUTER_RUNTIME_CODEX_CLI_ENABLE",
  "NEXUS_9ROUTER_BASE_URL",
  "NEXUS_9ROUTER_TOKEN",
  "ANTHROPIC_BASE_URL",
  "LOCAL_SERVICE_MODE",
];

function _snapshotEnv() {
  const snap = {};
  for (const k of VENDOR_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function _restoreEnv(snap) {
  for (const k of VENDOR_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function _loadEngine() {
  // Fresh module state per call so env vars are re-read.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST + path.sep)) delete require.cache[key];
  }
  const authz = require(path.join(DIST, "authz", "engine.js"));
  authz._reset();
  return authz;
}

async function _checkModelKeyRouting(modelKey) {
  // Clear cache FIRST, then mutate policies.json, then require engine.js —
  // engine's internal require(policies.json) must resolve to the SAME cached
  // (mutated) object. Reversing this order (mutate, then clear+reload) wipes
  // the mutation before engine.check() ever sees it.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST + path.sep)) delete require.cache[key];
  }

  const policiesPath = path.join(DIST, "authz", "policies.json");
  const policies = require(policiesPath);

  const testSkill = "__test.vendor-endpoint-routing";
  const originalSkill = policies.skills[testSkill];
  policies.skills[testSkill] = {
    tiers: { balanced: { modelKey } },
    maxOutputTokens: 4096,
    dailyTokenQuota: 2000000,
  };

  const authz = require(path.join(DIST, "authz", "engine.js"));
  authz._reset();

  try {
    return await authz.check(testSkill, "balanced");
  } finally {
    if (originalSkill === undefined) delete policies.skills[testSkill];
    else policies.skills[testSkill] = originalSkill;
    authz._reset();
  }
}

test("NEXUS_CLAUDE_BASE_URL=9router: anthropic tier resolves cc/ prefix + baseUrl", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_CLAUDE_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const authz = _loadEngine();
    const r = await authz.check(ANTHROPIC_SKILL, ANTHROPIC_TIER);
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.ok(r.model.startsWith("cc/"), `expected cc/ prefix, got model="${r.model}"`);
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_CLAUDE_BASE_URL empty: anthropic tier keeps bare model id", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_CLAUDE_BASE_URL = "";
  try {
    const authz = _loadEngine();
    const r = await authz.check(ANTHROPIC_SKILL, ANTHROPIC_TIER);
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.ok(!r.model.startsWith("cc/"), `expected bare id, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_DEEPSEEK_BASE_URL set: overrides registry baseUrl", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_DEEPSEEK_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1", "vendor env overrides registry baseUrl");
    assert.ok(r.model.startsWith("ds/"), `9router requires ds/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_DEEPSEEK_BASE_URL empty: keeps registry api.deepseek.com + bare model", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.baseUrl, "https://api.deepseek.com/v1", "registry baseUrl preserved");
    assert.ok(!r.model.startsWith("ds/"), `direct endpoint uses bare id, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_DEEPSEEK_BASE_URL=9router host: apiKeyEnv auto-switches to NEXUS_9ROUTER_TOKEN", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_DEEPSEEK_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN", "9router base must route to 9router token");
    assert.ok(r.model.startsWith("ds/"), `9router requires ds/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_DEEPSEEK_BASE_URL=9router endpoint: apiKeyEnv also switches", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_DEEPSEEK_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN", "local 9router proxy base must route to 9router token");
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_DEEPSEEK_BASE_URL empty: apiKeyEnv keeps registry NEXUS_DEEPSEEK_API_KEY", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.apiKeyEnv, "NEXUS_DEEPSEEK_API_KEY", "direct deepseek base must keep original key env");
    assert.ok(!r.model.startsWith("ds/"), `direct endpoint uses bare id, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE=1: routes through 9router base + token, ds/ prefix", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
    assert.ok(r.baseUrl.includes("9router"), `expected 9router baseUrl, got="${r.baseUrl}"`);
    assert.ok(r.model.startsWith("ds/"), `expected ds/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE=1 wins over NEXUS_DEEPSEEK_BASE_URL when both set", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  process.env.NEXUS_DEEPSEEK_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
    assert.equal(r.baseUrl, process.env.NEXUS_9ROUTER_BASE_URL, "flag must win over NEXUS_DEEPSEEK_BASE_URL");
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE unset + NEXUS_DEEPSEEK_BASE_URL unset: keeps registry default key", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.apiKeyEnv, "NEXUS_DEEPSEEK_API_KEY");
    assert.ok(!r.model.startsWith("ds/"), `expected bare model id, got="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_CODEX_BASE_URL set: resolved baseUrl carries that value", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_CODEX_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const r = await _checkModelKeyRouting("codex_cli");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "codex-cli");
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
    assert.ok(r.model.startsWith("cx/"), `9router requires cx/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_CODEX_BASE_URL empty: codex direct uses bare model id (no cx/)", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  try {
    const r = await _checkModelKeyRouting("codex_cli");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "codex-cli");
    assert.ok(!r.model.startsWith("cx/"), `direct endpoint uses bare id, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_9ROUTER_RUNTIME_CODEX_CLI_ENABLE=1: routes through 9router base + token, cx/ prefix", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_CODEX_CLI_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  try {
    const r = await _checkModelKeyRouting("codex_cli");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "codex-cli");
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
    assert.ok(r.baseUrl.includes("9router"), `expected 9router baseUrl, got="${r.baseUrl}"`);
    assert.ok(r.model.startsWith("cx/"), `expected cx/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_9ROUTER_RUNTIME_CODEX_CLI_ENABLE=1 wins over NEXUS_CODEX_BASE_URL when both set", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_CODEX_CLI_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  process.env.NEXUS_CODEX_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const r = await _checkModelKeyRouting("codex_cli");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "codex-cli");
    assert.equal(r.baseUrl, process.env.NEXUS_9ROUTER_BASE_URL, "flag must win over NEXUS_CODEX_BASE_URL");
    assert.ok(r.model.startsWith("cx/"), `expected cx/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("NEXUS_9ROUTER_RUNTIME_CODEX_CLI_ENABLE unset + NEXUS_CODEX_BASE_URL unset: keeps old behavior (bare model)", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  try {
    const r = await _checkModelKeyRouting("codex_cli");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "codex-cli");
    assert.ok(!r.model.startsWith("cx/"), `expected bare model id, got="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("backward-compat: ANTHROPIC_BASE_URL=9router (NEXUS_CLAUDE unset) still gets cc/ prefix", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.ANTHROPIC_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const authz = _loadEngine();
    const r = await authz.check(ANTHROPIC_SKILL, ANTHROPIC_TIER);
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.ok(r.model.startsWith("cc/"), `expected cc/ prefix via legacy var, got model="${r.model}"`);
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1", "legacy ANTHROPIC_BASE_URL used as baseUrl fallback");
  } finally {
    _restoreEnv(snap);
  }
});
