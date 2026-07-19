"use strict";

// commons/ai-gateway/test/vendor-endpoint.test.js
// Run: npm test (uses node --test). Build dist/ first (npm run build).
//
// Relocated 2026-07-19: proxy-vs-original endpoint resolution + model-id
// prefix normalization moved OUT of authz/engine.ts into a single shared
// layer lib/proxy-override/ (see test/proxy-override.test.js for isolated
// unit coverage of that function). engine.check() no longer reads
// NEXUS_CLAUDE_BASE_URL / NEXUS_DEEPSEEK_BASE_URL / NEXUS_CODEX_BASE_URL /
// NEXUS_9ROUTER_* itself — it only resolves registry/binding provider+model
// +baseUrl+apiKeyEnv.
//
// This file now keeps:
//   (a) engine.check() registry/binding-only tests (no proxy env set) —
//       confirms engine.ts still resolves modelKey → provider/model/baseUrl
//       /apiKeyEnv correctly post-refactor.
//   (b) composed pipeline tests: engine.check() output piped through
//       applyProxyOverride, mirroring what index.ts dispatchCall() actually
//       does — catches integration/field-shape bugs that isolated unit
//       tests on either layer alone would miss.
//   (c) priority-order regression guards (flag wins over URL override) that
//       weren't in the required proxy-override.test.js case list.

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
  "NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE",
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

function _loadProxyOverride() {
  return require(path.join(DIST, "lib", "proxy-override", "index.js"));
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

// --- (a) engine.check() registry/binding-only (no proxy env) ---------------

test("engine.check() (no proxy env): anthropic tier resolves bare model id", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  try {
    const authz = _loadEngine();
    const r = await authz.check(ANTHROPIC_SKILL, ANTHROPIC_TIER);
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.ok(!r.model.startsWith("cc/"), `expected bare id, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("engine.check() (no proxy env): deepseek_api modelKey resolves registry baseUrl + bare model + registry apiKeyEnv", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  try {
    const r = await _checkModelKeyRouting("deepseek_api");
    assert.equal(r.allow, true, `expected allow, got: ${r.reason}`);
    assert.equal(r.provider, "deepseek-api");
    assert.equal(r.baseUrl, "https://api.deepseek.com/v1", "registry baseUrl preserved");
    assert.equal(r.apiKeyEnv, "NEXUS_DEEPSEEK_API_KEY", "registry apiKeyEnv preserved");
    assert.ok(!r.model.startsWith("ds/"), `expected bare model id, got="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("engine.check() (no proxy env): codex_cli modelKey resolves bare model id", async () => {
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

// --- (b) composed pipeline: engine.check() piped through applyProxyOverride

test("composed pipeline: NEXUS_CLAUDE_BASE_URL=9router → engine.check()+applyProxyOverride yields cc/ prefix + baseUrl", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_CLAUDE_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const authz = _loadEngine();
    const bound = await authz.check(ANTHROPIC_SKILL, ANTHROPIC_TIER);
    assert.equal(bound.allow, true, `expected allow, got: ${bound.reason}`);
    const { applyProxyOverride } = _loadProxyOverride();
    const r = applyProxyOverride({
      provider: bound.provider,
      model: bound.model,
      baseUrl: bound.baseUrl,
      apiKeyEnv: bound.apiKeyEnv,
    });
    assert.ok(r.model.startsWith("cc/"), `expected cc/ prefix, got model="${r.model}"`);
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
  } finally {
    _restoreEnv(snap);
  }
});

test("composed pipeline: NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE=1 → engine.check()+applyProxyOverride yields ds/ prefix + 9router baseUrl + token", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  try {
    const bound = await _checkModelKeyRouting("deepseek_api");
    assert.equal(bound.allow, true, `expected allow, got: ${bound.reason}`);
    const { applyProxyOverride } = _loadProxyOverride();
    const r = applyProxyOverride({
      provider: bound.provider,
      model: bound.model,
      baseUrl: bound.baseUrl,
      apiKeyEnv: bound.apiKeyEnv,
    });
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
    assert.ok(r.baseUrl.includes("9router"), `expected 9router baseUrl, got="${r.baseUrl}"`);
    assert.ok(r.model.startsWith("ds/"), `expected ds/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("composed pipeline: NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE=1 → engine.check()+applyProxyOverride yields cx/ prefix + 9router baseUrl + token", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  try {
    const bound = await _checkModelKeyRouting("codex_cli");
    assert.equal(bound.allow, true, `expected allow, got: ${bound.reason}`);
    const { applyProxyOverride } = _loadProxyOverride();
    const r = applyProxyOverride({
      provider: bound.provider,
      model: bound.model,
      baseUrl: bound.baseUrl,
      apiKeyEnv: bound.apiKeyEnv,
    });
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
    assert.ok(r.baseUrl.includes("9router"), `expected 9router baseUrl, got="${r.baseUrl}"`);
    assert.ok(r.model.startsWith("cx/"), `expected cx/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});

test("composed pipeline backward-compat: legacy ANTHROPIC_BASE_URL (NEXUS_CLAUDE unset) still gets cc/ prefix", async () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.ANTHROPIC_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const authz = _loadEngine();
    const bound = await authz.check(ANTHROPIC_SKILL, ANTHROPIC_TIER);
    assert.equal(bound.allow, true, `expected allow, got: ${bound.reason}`);
    const { applyProxyOverride } = _loadProxyOverride();
    const r = applyProxyOverride({
      provider: bound.provider,
      model: bound.model,
      baseUrl: bound.baseUrl,
      apiKeyEnv: bound.apiKeyEnv,
    });
    assert.ok(r.model.startsWith("cc/"), `expected cc/ prefix via legacy var, got model="${r.model}"`);
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1", "legacy ANTHROPIC_BASE_URL used as baseUrl fallback");
  } finally {
    _restoreEnv(snap);
  }
});

// --- (c) priority-order regression guards (flag wins over URL override) ---

test("priority-order: NEXUS_CODEX_BASE_URL set (no flag) gets cx/ prefix + baseUrl carried, apiKeyEnv untouched", () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_CODEX_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const { applyProxyOverride } = _loadProxyOverride();
    const r = applyProxyOverride({ provider: "codex-cli", model: "gpt-5.5" });
    assert.equal(r.baseUrl, "https://9router.acegalaxy.co/v1");
    assert.ok(r.model.startsWith("cx/"), `9router requires cx/ prefix, got model="${r.model}"`);
    assert.equal(r.apiKeyEnv, undefined, "URL-only override (no flag) must not touch apiKeyEnv");
  } finally {
    _restoreEnv(snap);
  }
});

test("priority-order: deepseek NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE=1 wins over NEXUS_DEEPSEEK_BASE_URL when both set", () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  process.env.NEXUS_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
  try {
    const { applyProxyOverride } = _loadProxyOverride();
    const r = applyProxyOverride({
      provider: "deepseek-api",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "NEXUS_DEEPSEEK_API_KEY",
    });
    assert.equal(r.apiKeyEnv, "NEXUS_9ROUTER_TOKEN");
    assert.equal(r.baseUrl, process.env.NEXUS_9ROUTER_BASE_URL, "flag must win over NEXUS_DEEPSEEK_BASE_URL");
  } finally {
    _restoreEnv(snap);
  }
});

test("priority-order: codex NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE=1 wins over NEXUS_CODEX_BASE_URL when both set", () => {
  const snap = _snapshotEnv();
  for (const k of VENDOR_ENV_KEYS) delete process.env[k];
  process.env.NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.acegalaxy.co/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-9router-token";
  process.env.NEXUS_CODEX_BASE_URL = "https://9router.acegalaxy.co/v1";
  try {
    const { applyProxyOverride } = _loadProxyOverride();
    const r = applyProxyOverride({ provider: "codex-cli", model: "gpt-5.5" });
    assert.equal(r.baseUrl, process.env.NEXUS_9ROUTER_BASE_URL, "flag must win over NEXUS_CODEX_BASE_URL");
    assert.ok(r.model.startsWith("cx/"), `expected cx/ prefix, got model="${r.model}"`);
  } finally {
    _restoreEnv(snap);
  }
});
