"use strict";

// commons/ai-gateway/test/openai-embeddings.test.js
// Adapter-level test for OpenAIEmbeddingsAdapter. Mocks global fetch.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ADAPTER_PATH = path.join(__dirname, "..", "dist", "adapters", "api-key", "openai-embeddings.js");
const { OpenAIEmbeddingsAdapter } = require(ADAPTER_PATH);

function _mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

function _vec(seed, dim = 4) {
  const out = new Array(dim);
  for (let i = 0; i < dim; i += 1) out[i] = (seed + i) / 10;
  return out;
}

test("embeddings: single input → single vector + tokens", async () => {
  const restore = _mockFetch(async (url, opts) => {
    assert.equal(url, "https://api.openai.com/v1/embeddings");
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.input, ["hello world"]);
    return {
      ok: true, status: 200,
      json: async () => ({
        data: [{ index: 0, embedding: _vec(1) }],
        usage: { prompt_tokens: 7 },
      }),
    };
  });
  process.env.TEST_OPENAI_EMB_KEY = "sk-test";
  try {
    const adapter = new OpenAIEmbeddingsAdapter();
    const r = await adapter.embed({
      inputs: ["hello world"],
      model: "text-embedding-3-small",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "TEST_OPENAI_EMB_KEY",
    });
    assert.equal(r.vectors.length, 1);
    assert.deepEqual(r.vectors[0], _vec(1));
    assert.equal(r.tokensIn, 7);
  } finally {
    restore();
    delete process.env.TEST_OPENAI_EMB_KEY;
  }
});

test("embeddings: batch > 100 splits into multiple requests, preserves order", async () => {
  let callCount = 0;
  const restore = _mockFetch(async (_url, opts) => {
    callCount += 1;
    const body = JSON.parse(opts.body);
    // Echo each input back as a deterministic vector keyed by content.
    const data = body.input.map((s, idx) => ({
      index: idx,
      embedding: _vec(parseInt(s.replace("item-", ""), 10)),
    }));
    return {
      ok: true, status: 200,
      json: async () => ({ data, usage: { prompt_tokens: body.input.length } }),
    };
  });
  process.env.TEST_KEY = "test";
  try {
    const adapter = new OpenAIEmbeddingsAdapter();
    const inputs = Array.from({ length: 250 }, (_, i) => `item-${i}`);
    const r = await adapter.embed({
      inputs,
      model: "text-embedding-3-small",
      baseUrl: "https://x",
      apiKeyEnv: "TEST_KEY",
    });
    assert.equal(callCount, 3); // 100 + 100 + 50
    assert.equal(r.vectors.length, 250);
    // Order preserved.
    assert.deepEqual(r.vectors[0], _vec(0));
    assert.deepEqual(r.vectors[149], _vec(149));
    assert.deepEqual(r.vectors[249], _vec(249));
    assert.equal(r.tokensIn, 250);
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});

test("embeddings: API returns out-of-order data[].index → reordered by index", async () => {
  const restore = _mockFetch(async (_url, _opts) => ({
    ok: true, status: 200,
    json: async () => ({
      // Server returns vectors out of order (index 1 first).
      data: [
        { index: 1, embedding: _vec(11) },
        { index: 0, embedding: _vec(0) },
      ],
      usage: { prompt_tokens: 4 },
    }),
  }));
  process.env.TEST_KEY = "test";
  try {
    const adapter = new OpenAIEmbeddingsAdapter();
    const r = await adapter.embed({
      inputs: ["a", "b"],
      model: "m", baseUrl: "https://x", apiKeyEnv: "TEST_KEY",
    });
    assert.deepEqual(r.vectors[0], _vec(0));
    assert.deepEqual(r.vectors[1], _vec(11));
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});

test("embeddings: missing apiKeyEnv throws", async () => {
  const adapter = new OpenAIEmbeddingsAdapter();
  await assert.rejects(
    () => adapter.embed({ inputs: ["x"], model: "m", baseUrl: "https://x", apiKeyEnv: "NEVER_SET_EMB" }),
    /NEVER_SET_EMB not set/
  );
});

test("embeddings: empty inputs throws", async () => {
  process.env.TEST_KEY = "test";
  try {
    const adapter = new OpenAIEmbeddingsAdapter();
    await assert.rejects(
      () => adapter.embed({ inputs: [], model: "m", baseUrl: "https://x", apiKeyEnv: "TEST_KEY" }),
      /non-empty array/
    );
  } finally {
    delete process.env.TEST_KEY;
  }
});

test("embeddings: 4xx surfaces in error", async () => {
  const restore = _mockFetch(async () => ({
    ok: false, status: 429,
    text: async () => 'rate limit',
  }));
  process.env.TEST_KEY = "test";
  try {
    const adapter = new OpenAIEmbeddingsAdapter();
    await assert.rejects(
      () => adapter.embed({ inputs: ["x"], model: "m", baseUrl: "https://x", apiKeyEnv: "TEST_KEY" }),
      /429/
    );
  } finally {
    restore();
    delete process.env.TEST_KEY;
  }
});
