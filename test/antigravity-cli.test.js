"use strict";

// test/antigravity-cli.test.js
// Provider "antigravity-cli": Claude Code CLI adapter reused for proxied
// (9router) Gemini models, with its OWN circuit breaker + limit-cooldown key.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const cpModule = require("child_process");
const origSpawn = cpModule.spawn;

const AG_MODEL = "antigravity/gemini-3.1-pro-low";

function _resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST)) delete require.cache[key];
  }
}

function _stub(captured, { stdout = "ok", code = 0 } = {}) {
  return function _spawnStub(cmd, argv, opts) {
    if (captured) { captured.cmd = cmd; captured.argv = argv; captured.opts = opts; captured.calls = (captured.calls || 0) + 1; }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code, null);
    });
    return child;
  };
}

function _load() {
  _resetModules();
  const mod = require(path.join(DIST, "adapters", "subscription", "anthropic-cli.js"));
  const limitState = require(path.join(DIST, "lib", "claude-limit", "state.js"));
  return { Adapter: mod.AnthropicCLIAdapter, limitState };
}

test("provider getter: antigravity instance vs default", () => {
  const { Adapter } = _load();
  assert.equal(new Adapter({ provider: "antigravity-cli" }).provider, "antigravity-cli");
  assert.equal(new Adapter().provider, "anthropic-cli");
  assert.equal(new Adapter({}).provider, "anthropic-cli");
});

test("model: antigravity model reaches argv verbatim", async () => {
  const cap = {};
  cpModule.spawn = _stub(cap);
  try {
    const { Adapter } = _load();
    await new Adapter({ provider: "antigravity-cli" }).complete({ prompt: "x", model: AG_MODEL, maxOutputTokens: 1 });
    const i = cap.argv.indexOf("--model");
    assert.ok(i >= 0);
    assert.equal(cap.argv[i + 1], AG_MODEL);
  } finally { cpModule.spawn = origSpawn; }
});

test("model: 'sonnet' substring not collapsed for antigravity, still collapsed for default", async () => {
  const cap = {};
  cpModule.spawn = _stub(cap);
  try {
    const { Adapter } = _load();
    await new Adapter({ provider: "antigravity-cli" }).complete({ prompt: "x", model: " proxy/claude-sonnet-4-6 ", maxOutputTokens: 1 });
    assert.equal(cap.argv[cap.argv.indexOf("--model") + 1], "proxy/claude-sonnet-4-6");
    await new Adapter().complete({ prompt: "x", model: "claude-sonnet-4-6", maxOutputTokens: 1 });
    assert.equal(cap.argv[cap.argv.indexOf("--model") + 1], "sonnet");
  } finally { cpModule.spawn = origSpawn; }
});

test("model: empty model omits --model for antigravity", async () => {
  const cap = {};
  cpModule.spawn = _stub(cap);
  try {
    const { Adapter } = _load();
    await new Adapter({ provider: "antigravity-cli" }).complete({ prompt: "x", model: "  ", maxOutputTokens: 1 });
    assert.equal(cap.argv.includes("--model"), false);
  } finally { cpModule.spawn = origSpawn; }
});

test("limit isolation: Claude cooldown does not block antigravity for same skill", async () => {
  const cap = {};
  cpModule.spawn = _stub(cap);
  try {
    const { Adapter, limitState } = _load();
    limitState.markLimitHit("crawler.extract", { kind: "session_5h", resetAt: Date.now() + 60_000 });
    const r = await new Adapter({ provider: "antigravity-cli" }).complete({ prompt: "x", model: AG_MODEL, skill: "crawler.extract", maxOutputTokens: 1 });
    assert.equal(r.text, "ok");
    assert.equal(cap.calls, 1);
    // Default adapter still honours its own cooldown.
    await assert.rejects(
      new Adapter().complete({ prompt: "x", model: "sonnet", skill: "crawler.extract", maxOutputTokens: 1 }),
      (e) => e.isClaudeCliLimit === true && e.skill === "crawler.extract",
    );
    // Antigravity success must not clear the Claude cooldown.
    assert.equal(limitState.shouldSkip("crawler.extract").skip, true);
  } finally { cpModule.spawn = origSpawn; }
});

test("limit isolation: antigravity limit hit does not affect Claude skill key; error carries real skill", async () => {
  try {
    cpModule.spawn = _stub(null, { stdout: "Claude AI usage limit reached", code: 1 });
    const { Adapter, limitState } = _load();
    const ag = new Adapter({ provider: "antigravity-cli" });
    await assert.rejects(
      ag.complete({ prompt: "x", model: AG_MODEL, skill: "crawler.extract", maxOutputTokens: 1 }),
      (e) => e.isClaudeCliLimit === true && e.skill === "crawler.extract",
    );
    assert.equal(limitState.shouldSkip("crawler.extract").skip, false);
    assert.equal(limitState.shouldSkip("antigravity-cli:crawler.extract").skip, true);
  } finally { cpModule.spawn = origSpawn; }
});

test("dispatchCall: open anthropic-cli breaker does not deny antigravity-cli", async () => {
  const cap = {};
  const saved = {};
  for (const k of ["ANTHROPIC_BASE_URL", "NEXUS_CLAUDE_BASE_URL", "LOCAL_SERVICE_MODE"]) { saved[k] = process.env[k]; delete process.env[k]; }
  cpModule.spawn = _stub(cap);
  try {
    _resetModules();
    process.env.AI_GATEWAY_AUDIT_LOG_PATH = path.join(ROOT, "test", ".tmp-audit-ag.log");
    const gw = require(path.join(DIST, "index.js"));
    const breaker = require(path.join(DIST, "rate-limit", "circuit-breaker.js"));
    for (let i = 0; i < 5; i += 1) breaker.recordFailure("anthropic-cli");
    assert.equal(breaker._state_of("anthropic-cli"), "open");
    const r = await gw.dispatchCall({
      skill: "crawler.extract", tier: "balanced", prompt: "x",
      modelOverride: { provider: "antigravity-cli", model: AG_MODEL },
    });
    assert.notEqual(r.denyReason, "L4_circuit_open");
    assert.equal(r.provider, "antigravity-cli");
    assert.equal(r.model, AG_MODEL);
    assert.equal(cap.calls, 1, "adapter reached");
    assert.equal(cap.argv[cap.argv.indexOf("--model") + 1], AG_MODEL);
    assert.equal(breaker._state_of("antigravity-cli"), "closed");
  } finally {
    cpModule.spawn = origSpawn;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("proxy-override: antigravity-cli + antigravity/* model untouched (even with 9router env)", () => {
  const keys = ["ANTHROPIC_BASE_URL", "NEXUS_CLAUDE_BASE_URL"];
  const snap = {};
  for (const k of keys) snap[k] = process.env[k];
  try {
    _resetModules();
    const { applyProxyOverride } = require(path.join(DIST, "lib", "proxy-override", "index.js"));
    for (const k of keys) delete process.env[k];
    assert.equal(applyProxyOverride({ provider: "antigravity-cli", model: AG_MODEL, baseUrl: undefined }).model, AG_MODEL);
    for (const k of keys) process.env[k] = "https://9router.example.com/v1";
    const r = applyProxyOverride({ provider: "antigravity-cli", model: AG_MODEL, baseUrl: undefined });
    assert.equal(r.model, AG_MODEL);
    assert.equal(r.baseUrl, undefined);
  } finally {
    for (const k of keys) { if (snap[k] === undefined) delete process.env[k]; else process.env[k] = snap[k]; }
  }
});
