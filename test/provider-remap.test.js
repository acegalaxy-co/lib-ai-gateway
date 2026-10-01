"use strict";

// commons/ai-gateway/test/provider-remap.test.js
// Run: npm test (uses node --test). Build dist/ first (npm run build).
//
// Covers AI_GATEWAY_REMAP_<PROVIDER> (added 2026-10-01) — lets a consumer
// redirect every call that resolves to a given provider (tier binding,
// modelOverride, env-model-override, or the policy '*' default) to a
// different llmModels registry row, entirely via env — no code change, no
// hardcoded model/url/key in the lib. Use case: PROD Anthropic API credit
// exhausted → AI_GATEWAY_REMAP_ANTHROPIC_API=codex_api reroutes without
// touching policies.json. See index.ts _resolveRemapEnv()/dispatchCall() and
// authz/engine.ts resolveModelKey().
//
// Adapter network calls are mocked via global fetch (same pattern as
// test/openai-compat.test.js / test/deepseek.test.js) — never hits real APIs.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function _resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST + path.sep)) delete require.cache[key];
  }
}

function _load() {
  _resetModules();
  const tmpLog = path.join(ROOT, "test", ".tmp-audit-remap.log");
  try { fs.unlinkSync(tmpLog); } catch (_e) { /* ignore */ }
  process.env.AI_GATEWAY_AUDIT_LOG_PATH = tmpLog;
  const gw = require(path.join(DIST, "index.js"));
  return { gw };
}

function _mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

// '*' fallback policy (authz/policies.json) binds deep → legacy inline
// provider "anthropic-api" / model "claude-opus-4-7" (no modelKey) — a stable
// anthropic-api resolution target unaffected by registry fixture edits.
const ANTHROPIC_API_SKILL = "unknown.skill";
const ANTHROPIC_API_TIER = "deep";

const REMAP_ENV = "AI_GATEWAY_REMAP_ANTHROPIC_API";

// Dev machines commonly set ANTHROPIC_BASE_URL=<9router> so local runs hit
// the proxy by default — that would add a "cc/" prefix to the bare
// anthropic-api model id this test asserts (see dispatch.test.js _forceProd
// for the same guard on the same fixture skill/tier).
function _forceProd() {
  const keys = ["ANTHROPIC_BASE_URL", "NEXUS_CLAUDE_BASE_URL", "LOCAL_SERVICE_MODE"];
  const snap = {};
  for (const k of keys) {
    snap[k] = process.env[k];
    delete process.env[k];
  }
  return function restore() {
    for (const k of keys) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  };
}

function _restoreEnv(keys) {
  const snap = {};
  for (const k of keys) snap[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  };
}

test("remap happy path: anthropic-api -> openai-compat registry row, adapter gets row's model/baseUrl/apiKeyEnv, outcome.remappedFrom set", async () => {
  const restoreEnv = _restoreEnv([REMAP_ENV, "NEXUS_CODEX_API_KEY"]);
  process.env[REMAP_ENV] = "codex_api";
  process.env.NEXUS_CODEX_API_KEY = "test-codex-key";

  let observed = null;
  const restoreFetch = _mockFetch(async (url, opts) => {
    observed = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "remapped ok" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    };
  });

  try {
    const { gw } = _load();
    const r = await gw.dispatchCall({ skill: ANTHROPIC_API_SKILL, tier: ANTHROPIC_API_TIER, prompt: "x" });
    assert.equal(r.outcome, "allow", `expected allow, got deny: ${r.denyReason}`);
    assert.equal(r.provider, "openai-compat");
    assert.equal(r.model, "gpt-5.5");
    assert.equal(r.remappedFrom, "anthropic-api");
    assert.equal(observed.url, "https://proxy.example.com/v1/chat/completions");
    assert.equal(observed.headers.Authorization, "Bearer test-codex-key");
    assert.equal(observed.body.model, "gpt-5.5");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("remap to deepseek row goes through proxy-override (9router prefix + token swap)", async () => {
  const restoreEnv = _restoreEnv([
    REMAP_ENV,
    "NEXUS_DEEPSEEK_API_KEY",
    "NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE",
    "NEXUS_9ROUTER_BASE_URL",
    "NEXUS_9ROUTER_TOKEN",
  ]);
  process.env[REMAP_ENV] = "deepseek_api";
  process.env.NEXUS_DEEPSEEK_API_KEY = "unused-direct-key";
  process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE = "1";
  process.env.NEXUS_9ROUTER_BASE_URL = "https://9router.example.com/v1";
  process.env.NEXUS_9ROUTER_TOKEN = "test-proxy-token";

  let observed = null;
  // DeepSeekAdapter's non-streaming success path reads resp.text() (not
  // resp.json() — a 9router quirk, see deepseek.ts), so the mock must supply
  // both or the real adapter bug ("resp.text is not a function") masks the
  // remap assertion entirely.
  const restoreFetch = _mockFetch(async (url, opts) => {
    observed = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    const payload = JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    return {
      ok: true,
      status: 200,
      text: async () => payload,
      json: async () => JSON.parse(payload),
    };
  });

  try {
    const { gw } = _load();
    const r = await gw.dispatchCall({ skill: ANTHROPIC_API_SKILL, tier: ANTHROPIC_API_TIER, prompt: "x" });
    assert.equal(r.outcome, "allow", `expected allow, got deny: ${r.denyReason}`);
    assert.equal(r.provider, "deepseek-api");
    // proxy-override: 9router host != original api.deepseek.com -> ds/ prefix.
    assert.equal(r.model, "ds/deepseek-v4-pro");
    assert.equal(r.remappedFrom, "anthropic-api");
    assert.equal(observed.url, "https://9router.example.com/v1/chat/completions");
    assert.equal(observed.headers.Authorization, "Bearer test-proxy-token");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("unset remap env: provider/model unchanged from policy binding", async () => {
  const restoreEnv = _restoreEnv([REMAP_ENV]);
  const restoreProd = _forceProd();
  delete process.env[REMAP_ENV];
  try {
    const { gw } = _load();
    const r = await gw.dispatchCall({ skill: ANTHROPIC_API_SKILL, tier: ANTHROPIC_API_TIER, prompt: "x" });
    assert.equal(r.provider, "anthropic-api");
    assert.equal(r.model, "claude-opus-4-7");
    assert.equal(r.remappedFrom, undefined, "no remap applied -> field absent");
  } finally {
    restoreProd();
    restoreEnv();
  }
});

test("unknown remap modelKey -> L2_remap_invalid (no silent fallback to original provider)", async () => {
  const restoreEnv = _restoreEnv([REMAP_ENV]);
  process.env[REMAP_ENV] = "does_not_exist_in_registry";
  try {
    const { gw } = _load();
    const r = await gw.dispatchCall({ skill: ANTHROPIC_API_SKILL, tier: ANTHROPIC_API_TIER, prompt: "x" });
    assert.equal(r.outcome, "deny");
    assert.equal(r.denyReason, "L2_remap_invalid");
  } finally {
    restoreEnv();
  }
});

test("remap also applies on the modelOverride path", async () => {
  const restoreEnv = _restoreEnv([REMAP_ENV, "NEXUS_CODEX_API_KEY"]);
  process.env[REMAP_ENV] = "codex_api";
  process.env.NEXUS_CODEX_API_KEY = "test-codex-key-2";

  const restoreFetch = _mockFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));

  try {
    const { gw } = _load();
    const r = await gw.dispatchCall({
      skill: "invoice-enrich.summarize",
      tier: "fast",
      prompt: "x",
      modelOverride: { provider: "anthropic-api", model: "claude-whatever" },
    });
    assert.equal(r.outcome, "allow", `expected allow, got deny: ${r.denyReason}`);
    assert.equal(r.provider, "openai-compat");
    assert.equal(r.model, "gpt-5.5");
    assert.equal(r.remappedFrom, "anthropic-api");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});
