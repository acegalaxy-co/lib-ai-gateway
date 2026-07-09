"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const ADAPTER_PATH = path.join(__dirname, "..", "dist", "adapters", "api-key", "anthropic-api.js");

function _mockSdk(MockAnthropic, originalRequire) {
  Module.prototype.require = function _require(id) {
    if (id === "@anthropic-ai/sdk") {
      return { default: MockAnthropic };
    }
    return originalRequire.apply(this, arguments);
  };
}

function _clearAdapterCache() {
  delete require.cache[require.resolve(ADAPTER_PATH)];
}

test("anthropic-api: custom apiKeyEnv constructs client and returns text", async () => {
  const originalRequire = Module.prototype.require;
  const constructorCalls = [];

  try {
    _mockSdk(class {
      constructor(options) {
        constructorCalls.push(options.apiKey);
      }
      messages = {
        create: async () => ({
          stop_reason: null,
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };
    }, originalRequire);
    _clearAdapterCache();

    process.env.TEST_ANTHROPIC_KEY = "custom-key";
    const { AnthropicAPIAdapter } = require(ADAPTER_PATH);
    const adapter = new AnthropicAPIAdapter();
    const r = await adapter.complete({
      prompt: "hello",
      model: "claude-test",
      maxOutputTokens: 100,
      apiKeyEnv: "TEST_ANTHROPIC_KEY",
    });

    assert.equal(r.text, "hello");
    assert.equal(r.tokensIn, 10);
    assert.equal(r.tokensOut, 5);
    assert.deepEqual(constructorCalls, ["custom-key"]);
  } finally {
    Module.prototype.require = originalRequire;
    _clearAdapterCache();
    delete process.env.TEST_ANTHROPIC_KEY;
  }
});

test("anthropic-api: missing custom apiKeyEnv throws clear env error", async () => {
  const originalRequire = Module.prototype.require;

  try {
    _mockSdk(class {}, originalRequire);
    _clearAdapterCache();

    delete process.env.MISSING_ANTHROPIC_KEY;
    const { AnthropicAPIAdapter } = require(ADAPTER_PATH);
    const adapter = new AnthropicAPIAdapter();

    await assert.rejects(
      () => adapter.complete({
        prompt: "hello",
        model: "claude-test",
        maxOutputTokens: 100,
        apiKeyEnv: "MISSING_ANTHROPIC_KEY",
      }),
      /Expected environment variable: MISSING_ANTHROPIC_KEY/
    );
  } finally {
    Module.prototype.require = originalRequire;
    _clearAdapterCache();
    delete process.env.MISSING_ANTHROPIC_KEY;
  }
});

test("anthropic-api: fallback env works when apiKeyEnv is absent", async () => {
  const originalRequire = Module.prototype.require;
  const constructorCalls = [];

  try {
    _mockSdk(class {
      constructor(options) {
        constructorCalls.push(options.apiKey);
      }
      messages = {
        create: async () => ({
          stop_reason: null,
          content: [{ type: "text", text: "fallback works" }],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      };
    }, originalRequire);
    _clearAdapterCache();

    process.env.ANTHROPIC_API_KEY = "fallback-key";
    delete process.env.NEXUS_ANTHROPIC_API_KEY;
    const { AnthropicAPIAdapter } = require(ADAPTER_PATH);
    const adapter = new AnthropicAPIAdapter();
    const r = await adapter.complete({
      prompt: "test",
      model: "claude-test",
      maxOutputTokens: 100,
    });

    assert.equal(r.text, "fallback works");
    assert.deepEqual(constructorCalls, ["fallback-key"]);
  } finally {
    Module.prototype.require = originalRequire;
    _clearAdapterCache();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NEXUS_ANTHROPIC_API_KEY;
  }
});

test("anthropic-api: missing fallback env throws clear env error", async () => {
  const originalRequire = Module.prototype.require;

  try {
    _mockSdk(class {}, originalRequire);
    _clearAdapterCache();

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NEXUS_ANTHROPIC_API_KEY;
    const { AnthropicAPIAdapter } = require(ADAPTER_PATH);
    const adapter = new AnthropicAPIAdapter();

    await assert.rejects(
      () => adapter.complete({
        prompt: "test",
        model: "claude-test",
        maxOutputTokens: 100,
      }),
      /Expected environment variable: ANTHROPIC_API_KEY or NEXUS_ANTHROPIC_API_KEY/
    );
  } finally {
    Module.prototype.require = originalRequire;
    _clearAdapterCache();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NEXUS_ANTHROPIC_API_KEY;
  }
});

test("anthropic-api: different apiKeyEnv values construct separate clients", async () => {
  const originalRequire = Module.prototype.require;
  const constructorCalls = [];

  try {
    _mockSdk(class {
      constructor(options) {
        constructorCalls.push(options.apiKey);
      }
      messages = {
        create: async () => ({
          stop_reason: null,
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    }, originalRequire);
    _clearAdapterCache();

    process.env.KEY_A = "first-key";
    process.env.KEY_B = "second-key";
    const { AnthropicAPIAdapter } = require(ADAPTER_PATH);
    const adapter = new AnthropicAPIAdapter();

    await adapter.complete({ prompt: "a", model: "claude-test", maxOutputTokens: 10, apiKeyEnv: "KEY_A" });
    await adapter.complete({ prompt: "b", model: "claude-test", maxOutputTokens: 10, apiKeyEnv: "KEY_B" });

    assert.deepEqual(constructorCalls, ["first-key", "second-key"]);
  } finally {
    Module.prototype.require = originalRequire;
    _clearAdapterCache();
    delete process.env.KEY_A;
    delete process.env.KEY_B;
  }
});
