"use strict";

// commons/ai-gateway/test/openai-compat.test.js
// Adapter-level test for OpenAICompatAdapter. Mocks global fetch to avoid network.
// Run via npm test (uses node --test discovery).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ADAPTER_PATH = path.join(__dirname, "..", "dist", "adapters", "api-key", "openai-compat.js");
const { OpenAICompatAdapter } = require(ADAPTER_PATH);

function _mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

test("openai-compat: success path returns text + token usage", async () => {
  const restore = _mockFetch(async (url, opts) => {
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "deepseek-v4-pro");
    assert.equal(body.max_tokens, 512);
    assert.equal(body.messages[0].content, "hello");
    assert.equal(opts.headers["Authorization"], "Bearer test-key-deepseek");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "hi back" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    };
  });
  process.env.TEST_DEEPSEEK_KEY = "test-key-deepseek";

  try {
    const adapter = new OpenAICompatAdapter();
    const r = await adapter.complete({
      prompt: "hello",
      model: "deepseek-v4-pro",
      maxOutputTokens: 512,
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "TEST_DEEPSEEK_KEY",
    });
    assert.equal(r.text, "hi back");
    assert.equal(r.tokensIn, 5);
    assert.equal(r.tokensOut, 3);
    assert.equal(r.schemaJson, null);
  } finally {
    restore();
    delete process.env.TEST_DEEPSEEK_KEY;
  }
});

test("openai-compat: GPT-5 uses max_completion_tokens (not max_tokens)", async () => {
  let observedBody = null;
  const restore = _mockFetch(async (_url, opts) => {
    observedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  });
  process.env.TEST_OPENAI_KEY = "test";

  try {
    const adapter = new OpenAICompatAdapter();
    await adapter.complete({
      prompt: "x", model: "gpt-5.4-mini", maxOutputTokens: 100,
      baseUrl: "https://api.openai.com/v1", apiKeyEnv: "TEST_OPENAI_KEY",
    });
    assert.equal(observedBody.max_completion_tokens, 100);
    assert.equal(observedBody.max_tokens, undefined);
  } finally {
    restore();
    delete process.env.TEST_OPENAI_KEY;
  }
});

test("openai-compat: non-GPT model uses max_tokens", async () => {
  let observedBody = null;
  const restore = _mockFetch(async (_url, opts) => {
    observedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  });
  process.env.TEST_GEMINI_KEY = "test";

  try {
    const adapter = new OpenAICompatAdapter();
    await adapter.complete({
      prompt: "x", model: "gemini-2.5-flash", maxOutputTokens: 100,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKeyEnv: "TEST_GEMINI_KEY",
    });
    assert.equal(observedBody.max_tokens, 100);
    assert.equal(observedBody.max_completion_tokens, undefined);
  } finally {
    restore();
    delete process.env.TEST_GEMINI_KEY;
  }
});

test("openai-compat: missing apiKeyEnv throws", async () => {
  const adapter = new OpenAICompatAdapter();
  await assert.rejects(
    () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 1, baseUrl: "https://x", apiKeyEnv: "NEVER_SET_XYZ" }),
    /NEVER_SET_XYZ not set/
  );
});

test("openai-compat: missing baseUrl throws", async () => {
  const adapter = new OpenAICompatAdapter();
  await assert.rejects(
    () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 1, apiKeyEnv: "ANY" }),
    /missing baseUrl/
  );
});

test("openai-compat: 4xx error surfaces in throw message", async () => {
  const restore = _mockFetch(async () => ({
    ok: false, status: 400,
    text: async () => '{"error":"bad request"}',
  }));
  process.env.TEST_KEY = "test";
  try {
    const adapter = new OpenAICompatAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 1, baseUrl: "https://x", apiKeyEnv: "TEST_KEY" }),
      /400/
    );
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});

test("openai-compat: schema set + valid JSON content → schemaJson populated", async () => {
  const restore = _mockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"vendor":"Anthropic","amount":20}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    }),
  }));
  process.env.TEST_KEY = "test";
  try {
    const adapter = new OpenAICompatAdapter();
    const r = await adapter.complete({
      prompt: "extract", model: "m", maxOutputTokens: 100,
      baseUrl: "https://x", apiKeyEnv: "TEST_KEY",
      schema: { type: "object" },
    });
    assert.deepEqual(r.schemaJson, { vendor: "Anthropic", amount: 20 });
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});
