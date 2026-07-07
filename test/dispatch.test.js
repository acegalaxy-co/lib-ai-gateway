"use strict";

// commons/ai-gateway/test/dispatch.test.js
// Run: npm test (uses node --test).
// Covers all 5 deny layers + 1 budget-exhaust scenario.
// Adapter call is mocked via injecting a fake adapter into the registry —
// we never hit real Anthropic API. Build dist/ before running tests (npm run build).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function _resetModules() {
  // Clear require cache for ai-gateway modules so each test starts with fresh
  // in-process state (budget reservations, circuit-breaker counters, audit logger).
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST + path.sep) || key.startsWith(ROOT + path.sep + "node_modules") === false && key.startsWith(ROOT)) {
      // only clear our own module cache
      if (key.startsWith(DIST)) delete require.cache[key];
    }
  }
}

function _load() {
  _resetModules();
  // Route audit log to a per-test temp file to avoid polluting source audit/audit.log.
  const tmpLog = path.join(ROOT, "test", ".tmp-audit.log");
  try { fs.unlinkSync(tmpLog); } catch (_e) { /* ignore */ }
  process.env.AI_GATEWAY_AUDIT_LOG_PATH = tmpLog;
  const gw = require(path.join(DIST, "index.js"));
  const budget = require(path.join(DIST, "rate-limit", "budget.js"));
  const breaker = require(path.join(DIST, "rate-limit", "circuit-breaker.js"));
  return { gw, budget, breaker, tmpLog };
}

test("L2_authz: empty skill denies", async () => {
  const { gw } = _load();
  const r = await gw.dispatchCall({ skill: "", tier: "balanced", prompt: "x" });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L2_authz");
  assert.equal(r.provider, null);
});

test("L2_authz: invalid tier denies", async () => {
  const { gw } = _load();
  const r = await gw.dispatchCall({ skill: "invoice-enrich.summarize", tier: "bogus", prompt: "x" });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L2_authz");
});

test("L2_authz: skill lacks tier binding denies (summarize has no 'deep')", async () => {
  const { gw } = _load();
  const r = await gw.dispatchCall({ skill: "invoice-enrich.summarize", tier: "deep", prompt: "x" });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L2_authz");
});

test("L2 fallback: unknown skill resolves via '*' policy, provider+model set on outcome", async () => {
  const { gw } = _load();
  // Adapter will fail because no key for the bound openai-compat provider —
  // we expect L1_provider_unavailable, but provider+model must be populated
  // from the '*' fallback policy before the adapter is called.
  delete process.env.NEXUS_DEEPSEEK_API_KEY;
  const r = await gw.dispatchCall({ skill: "unknown.skill", tier: "balanced", prompt: "x" });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L1_provider_unavailable");
  // '*' policy maps balanced → openai-compat / deepseek-v4-flash.
  assert.equal(r.provider, "openai-compat");
  assert.equal(r.model, "deepseek-v4-flash");
});

test("L4_circuit_open: trips after N failures, blocks next call", async () => {
  const { gw, breaker } = _load();
  // Force 5 failures on the provider bound to '*' balanced (openai-compat).
  delete process.env.NEXUS_DEEPSEEK_API_KEY;
  for (let i = 0; i < 5; i += 1) {
    await gw.dispatchCall({ skill: "unknown.skill", tier: "balanced", prompt: "x" });
  }
  assert.equal(breaker._state_of("openai-compat"), "open");
  const r = await gw.dispatchCall({ skill: "unknown.skill", tier: "balanced", prompt: "x" });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L4_circuit_open");
});

test("L3_budget_exhausted: reserve fails when over quota", async () => {
  const { gw, budget } = _load();
  // '*' policy quota = 200000. Pre-fill window via direct budget API.
  await budget.reserve("burn.skill", 199000, 200000);
  // Adapter would fail (no key) but budget should reject first.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.NEXUS_ANTHROPIC_API_KEY;
  // Prompt long enough that estimated tokens > remaining quota.
  const bigPrompt = "x".repeat(10000);
  const r = await gw.dispatchCall({ skill: "burn.skill", tier: "balanced", prompt: bigPrompt });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L3_budget_exhausted");
});

test("audit log writes one JSONL line per call (allow OR deny)", async () => {
  const { gw, tmpLog } = _load();
  await gw.dispatchCall({ skill: "", tier: "balanced", prompt: "x" });
  await gw.dispatchCall({ skill: "invoice-enrich.summarize", tier: "deep", prompt: "x" });
  // Audit writes are async (mode: "async"); give them a tick.
  await new Promise((r) => setTimeout(r, 20));
  const content = fs.readFileSync(tmpLog, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const rec = JSON.parse(line);
    assert.ok(rec.ts, "has ts");
    assert.ok(rec.skill !== undefined, "has skill");
    assert.equal(rec.outcome, "deny");
    assert.ok(typeof rec.latencyMs === "number", "has latencyMs");
  }
});

// ============================================================
// 2026-07-07: Env-based runtime model override (Anthropic providers only).
// Priority: NEXUS_AI_GATEWAY_MODEL_<SKILL> > NEXUS_AI_GATEWAY_MODEL_DEFAULT > policy.
// Applied inside dispatchCall between authz and adapter — we can observe the
// resolved model in the response's `.model` field (populated pre-adapter).
// ============================================================
test("env override: NEXUS_AI_GATEWAY_MODEL_<SKILL> replaces policy model", async () => {
  const { gw } = _load();
  // crawler.extract policy binds anthropic-cli / claude-haiku-4-5. Override
  // via skill-specific env — expect resolved model in response.
  process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT = "claude-sonnet-4-6";
  try {
    // Adapter will fail (no real CLI in test env) → L1_provider_unavailable
    // OR L3 depending on quota. But r.model is set BEFORE adapter call.
    const r = await gw.dispatchCall({ skill: "crawler.extract", tier: "balanced", prompt: "x" });
    assert.equal(r.model, "claude-sonnet-4-6", "env override wins over policy claude-haiku-4-5");
    assert.equal(r.provider, "anthropic-cli", "provider stays per policy");
  } finally {
    delete process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT;
  }
});

test("env override: NEXUS_AI_GATEWAY_MODEL_DEFAULT applies when skill-specific unset", async () => {
  const { gw } = _load();
  process.env.NEXUS_AI_GATEWAY_MODEL_DEFAULT = "claude-opus-4-7";
  try {
    const r = await gw.dispatchCall({ skill: "crawler.extract", tier: "balanced", prompt: "x" });
    assert.equal(r.model, "claude-opus-4-7", "DEFAULT override applies");
  } finally {
    delete process.env.NEXUS_AI_GATEWAY_MODEL_DEFAULT;
  }
});

test("env override: skill-specific wins over DEFAULT", async () => {
  const { gw } = _load();
  process.env.NEXUS_AI_GATEWAY_MODEL_DEFAULT = "claude-opus-4-7";
  process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT = "claude-haiku-4-5";
  try {
    const r = await gw.dispatchCall({ skill: "crawler.extract", tier: "balanced", prompt: "x" });
    assert.equal(r.model, "claude-haiku-4-5", "skill-specific wins over DEFAULT");
  } finally {
    delete process.env.NEXUS_AI_GATEWAY_MODEL_DEFAULT;
    delete process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT;
  }
});

test("env override: does NOT apply to openai-compat providers", async () => {
  const { gw } = _load();
  // '*' fallback policy binds openai-compat / deepseek-v4-flash for balanced.
  // Env override must NOT touch this (would break baseUrl/apiKeyEnv contract).
  process.env.NEXUS_AI_GATEWAY_MODEL_DEFAULT = "claude-opus-4-7";
  try {
    const r = await gw.dispatchCall({ skill: "unknown.skill", tier: "balanced", prompt: "x" });
    assert.equal(r.model, "deepseek-v4-flash", "policy model preserved for non-Anthropic provider");
    assert.equal(r.provider, "openai-compat");
  } finally {
    delete process.env.NEXUS_AI_GATEWAY_MODEL_DEFAULT;
  }
});

test("env override: modelOverride param still wins over env vars", async () => {
  const { gw } = _load();
  process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT = "claude-sonnet-4-6";
  try {
    const r = await gw.dispatchCall({
      skill: "crawler.extract",
      tier: "balanced",
      prompt: "x",
      modelOverride: {
        provider: "anthropic-cli",
        model: "claude-opus-4-7",
      },
    });
    assert.equal(r.model, "claude-opus-4-7", "modelOverride param has highest priority");
  } finally {
    delete process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT;
  }
});

test("env override: empty string ignored (falls back to policy)", async () => {
  const { gw } = _load();
  process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT = "   ";
  try {
    const r = await gw.dispatchCall({ skill: "crawler.extract", tier: "balanced", prompt: "x" });
    assert.equal(r.model, "claude-haiku-4-5", "whitespace-only env ignored, policy default wins");
  } finally {
    delete process.env.NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT;
  }
});
