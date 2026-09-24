"use strict";

// commons/ai-gateway/test/deepseek.test.js
// Adapter-level test for DeepSeekAdapter. Mocks global fetch to avoid network.
// Mirrors openai-compat.test.js — DeepSeek shares the Chat Completions wire
// format but has its own provider id + response_format tuning.
// Run via npm test (uses node --test discovery).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ADAPTER_PATH = path.join(__dirname, "..", "dist", "adapters", "api-key", "deepseek.js");
const { DeepSeekAdapter } = require(ADAPTER_PATH);

function _mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

test("deepseek-api: provider getter returns deepseek-api", () => {
  const adapter = new DeepSeekAdapter();
  assert.equal(adapter.provider, "deepseek-api");
});

test("deepseek-api: success path returns text + token usage, correct URL/auth/model", async () => {
  const restore = _mockFetch(async (url, opts) => {
    assert.equal(url, "https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "deepseek-v4-pro");
    assert.equal(body.max_tokens, 512);
    assert.equal(body.messages[0].content, "hello");
    assert.equal(opts.headers["Authorization"], "Bearer test-key-deepseek");
    const payload = {
      choices: [{ message: { content: "hi back" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  });
  process.env.TEST_DEEPSEEK_KEY = "test-key-deepseek";

  try {
    const adapter = new DeepSeekAdapter();
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

test("deepseek-api: strips SSE 'data: [DONE]' tail after JSON (9router quirk)", async () => {
  const payload = {
    choices: [{ message: { content: "OK" } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
  const restore = _mockFetch(async () => ({
    ok: true,
    status: 200,
    // 9router appends an SSE terminator even for non-stream requests.
    text: async () => JSON.stringify(payload) + "data: [DONE]\n\n",
    json: async () => { throw new SyntaxError("Unexpected non-whitespace character after JSON"); },
  }));
  process.env.TEST_DEEPSEEK_KEY = "test-key-deepseek";
  try {
    const adapter = new DeepSeekAdapter();
    const r = await adapter.complete({
      prompt: "hi",
      model: "ds/deepseek-v4-pro",
      maxOutputTokens: 20,
      baseUrl: "https://9router.example.com/v1",
      apiKeyEnv: "TEST_DEEPSEEK_KEY",
    });
    assert.equal(r.text, "OK", "SSE tail stripped, JSON parsed");
    assert.equal(r.tokensOut, 2);
  } finally {
    restore();
    delete process.env.TEST_DEEPSEEK_KEY;
  }
});

test("deepseek-api: schema set → response_format json_object enforced in request", async () => {
  let observedBody = null;
  const restore = _mockFetch(async (_url, opts) => {
    observedBody = JSON.parse(opts.body);
    const payload = {
      choices: [{ message: { content: '{"vendor":"Anthropic","amount":20}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  });
  process.env.TEST_KEY = "test";
  try {
    const adapter = new DeepSeekAdapter();
    const r = await adapter.complete({
      prompt: "extract", model: "deepseek-v4-pro", maxOutputTokens: 100,
      baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "TEST_KEY",
      schema: { type: "object" },
    });
    assert.deepEqual(observedBody.response_format, { type: "json_object" });
    assert.deepEqual(r.schemaJson, { vendor: "Anthropic", amount: 20 });
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});

test("deepseek-api: no schema → response_format omitted", async () => {
  let observedBody = null;
  const restore = _mockFetch(async (_url, opts) => {
    observedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  });
  process.env.TEST_KEY = "test";
  try {
    const adapter = new DeepSeekAdapter();
    await adapter.complete({
      prompt: "x", model: "deepseek-v4-pro", maxOutputTokens: 100,
      baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "TEST_KEY",
    });
    assert.equal(observedBody.response_format, undefined);
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});

test("deepseek-api: reasoning_content (thinking mode) not leaked into text on tool_calls path", async () => {
  const _toolPayload = {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "final answer",
        reasoning_content: "step-by-step internal reasoning",
        tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: '{"q":"x"}' } }],
      },
    }],
    usage: { prompt_tokens: 4, completion_tokens: 6 },
  };
  const restore = _mockFetch(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(_toolPayload),
    json: async () => _toolPayload,
  }));
  process.env.TEST_KEY = "test";
  try {
    const adapter = new DeepSeekAdapter();
    const r = await adapter.complete({
      prompt: "x", model: "deepseek-v4-pro", maxOutputTokens: 100,
      baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "TEST_KEY",
    });
    assert.equal(r.needsToolExecution, true);
    assert.equal(r.text, null, "top-level text stays null for tool_calls turn");
    const reasoningBlock = r.response.content.find((b) => b.type === "reasoning_content");
    assert.equal(reasoningBlock.text, "step-by-step internal reasoning");
    const textBlock = r.response.content.find((b) => b.type === "text");
    assert.equal(textBlock.text, "final answer");
    const toolBlock = r.response.content.find((b) => b.type === "tool_use");
    assert.deepEqual(toolBlock.input, { q: "x" });
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});

test("deepseek-api: missing apiKeyEnv throws", async () => {
  const adapter = new DeepSeekAdapter();
  await assert.rejects(
    () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 1, baseUrl: "https://x", apiKeyEnv: "NEVER_SET_XYZ" }),
    /NEVER_SET_XYZ not set/
  );
});

test("deepseek-api: missing baseUrl throws", async () => {
  const adapter = new DeepSeekAdapter();
  await assert.rejects(
    () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 1, apiKeyEnv: "ANY" }),
    /missing baseUrl/
  );
});

test("deepseek-api: non-200 error surfaces provider name + status in throw message", async () => {
  const restore = _mockFetch(async () => ({
    ok: false, status: 400,
    text: async () => '{"error":"bad request"}',
  }));
  process.env.TEST_KEY = "test";
  try {
    const adapter = new DeepSeekAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 1, baseUrl: "https://x", apiKeyEnv: "TEST_KEY" }),
      /deepseek-api.*400/
    );
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});

test("deepseek-api: estimateTokens uses len/3.5 heuristic", () => {
  const adapter = new DeepSeekAdapter();
  assert.equal(adapter.estimateTokens("x".repeat(35)), 10);
});
