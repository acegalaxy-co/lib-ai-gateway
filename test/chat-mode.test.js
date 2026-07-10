"use strict";

// commons/ai-gateway/test/chat-mode.test.js
// Phase 4 — chat-mode (messages + tools + streaming + modelOverride).
// Validates the openai-compat path end-to-end via dispatchCall (anthropic-api
// path is exercised in adapter unit tests; we focus here on integration).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

function _resetModules() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(DIST + path.sep)) delete require.cache[k];
  }
}

function _load() {
  _resetModules();
  const tmpLog = path.join(ROOT, "test", ".tmp-audit-chat.log");
  try { fs.unlinkSync(tmpLog); } catch (_e) { /* ignore */ }
  process.env.AI_GATEWAY_AUDIT_LOG_PATH = tmpLog;
  return require(path.join(DIST, "index.js"));
}

function _mockFetch(handler) {
  const orig = globalThis.fetch;
  // Adapters now read the non-stream body via resp.text() (to strip proxy SSE
  // tails). Auto-derive text() from json() so mocks that only define json still
  // work: text() returns the JSON-stringified payload.
  globalThis.fetch = async (...args) => {
    const resp = await handler(...args);
    if (resp && typeof resp.json === "function" && typeof resp.text !== "function") {
      resp.text = async () => JSON.stringify(await resp.json());
    }
    return resp;
  };
  return () => { globalThis.fetch = orig; };
}

test("chat-mode: messages[] + system prompt → translated to OpenAI shape", async () => {
  const gw = _load();
  process.env.NEXUS_DEEPSEEK_API_KEY = "sk-test";
  let observedBody = null;
  const restore = _mockFetch(async (_url, opts) => {
    observedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    };
  });
  try {
    const r = await gw.dispatchCall({
      skill: "nexus.chat",
      tier: "balanced",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ],
      systemPrompt: "You are helpful.",
      maxOutputTokens: 100,
    });
    assert.equal(r.outcome, "allow");
    assert.equal(r.text, "ok");
    // Verify OpenAI translation: system first, then user/assistant alternation.
    assert.equal(observedBody.messages[0].role, "system");
    assert.equal(observedBody.messages[0].content, "You are helpful.");
    assert.equal(observedBody.messages[1].role, "user");
    assert.equal(observedBody.messages[1].content, "Hello");
    assert.equal(observedBody.messages[2].role, "assistant");
    assert.equal(observedBody.messages[3].role, "user");
  } finally {
    restore();
    delete process.env.NEXUS_DEEPSEEK_API_KEY;
  }
});

test("chat-mode: tools[] passed as OpenAI function specs", async () => {
  const gw = _load();
  process.env.NEXUS_DEEPSEEK_API_KEY = "sk-test";
  let observedBody = null;
  const restore = _mockFetch(async (_url, opts) => {
    observedBody = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }),
    };
  });
  try {
    await gw.dispatchCall({
      skill: "nexus.chat",
      tier: "balanced",
      messages: [{ role: "user", content: "x" }],
      tools: [
        { name: "get_weather", description: "Get weather", input_schema: { type: "object" } },
      ],
      maxOutputTokens: 100,
    });
    assert.equal(observedBody.tools.length, 1);
    assert.equal(observedBody.tools[0].type, "function");
    assert.equal(observedBody.tools[0].function.name, "get_weather");
    assert.equal(observedBody.tools[0].function.description, "Get weather");
  } finally {
    restore();
    delete process.env.NEXUS_DEEPSEEK_API_KEY;
  }
});

test("chat-mode: tool_calls in response → needsToolExecution + Anthropic-shape content", async () => {
  const gw = _load();
  process.env.NEXUS_DEEPSEEK_API_KEY = "sk-test";
  const restore = _mockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "Let me check.",
          tool_calls: [{
            id: "call_abc",
            function: { name: "get_weather", arguments: '{"city":"Hanoi"}' },
          }],
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    }),
  }));
  try {
    const r = await gw.dispatchCall({
      skill: "nexus.chat",
      tier: "balanced",
      messages: [{ role: "user", content: "weather in Hanoi" }],
      tools: [{ name: "get_weather", description: "x", input_schema: {} }],
      maxOutputTokens: 100,
    });
    assert.equal(r.outcome, "allow");
    assert.equal(r.needsToolExecution, true);
    assert.equal(r.response.stop_reason, "tool_use");
    // Anthropic-shape: text + tool_use blocks.
    const textBlock = r.response.content.find((b) => b.type === "text");
    assert.equal(textBlock.text, "Let me check.");
    const toolBlock = r.response.content.find((b) => b.type === "tool_use");
    assert.equal(toolBlock.name, "get_weather");
    assert.equal(toolBlock.id, "call_abc");
    assert.deepEqual(toolBlock.input, { city: "Hanoi" });
  } finally {
    restore();
    delete process.env.NEXUS_DEEPSEEK_API_KEY;
  }
});

test("chat-mode: modelOverride replaces tier binding (provider+model+baseUrl+apiKeyEnv)", async () => {
  const gw = _load();
  process.env.NEXUS_OPENAI_API_KEY = "sk-test-openai";
  let observedUrl = null;
  let observedAuth = null;
  let observedModel = null;
  const restore = _mockFetch(async (url, opts) => {
    observedUrl = url;
    observedAuth = opts.headers.Authorization;
    observedModel = JSON.parse(opts.body).model;
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" } }], usage: {} }),
    };
  });
  try {
    // Skill nexus.chat balanced → openai-compat / deepseek by policy.
    // Override to point at OpenAI's gpt-5.4-mini instead.
    const r = await gw.dispatchCall({
      skill: "nexus.chat",
      tier: "balanced",
      messages: [{ role: "user", content: "x" }],
      maxOutputTokens: 100,
      modelOverride: {
        provider: "openai-compat",
        model: "gpt-5.4-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "NEXUS_OPENAI_API_KEY",
      },
    });
    assert.equal(r.outcome, "allow");
    assert.equal(r.provider, "openai-compat");
    assert.equal(r.model, "gpt-5.4-mini");
    assert.equal(observedUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(observedAuth, "Bearer sk-test-openai");
    assert.equal(observedModel, "gpt-5.4-mini");
  } finally {
    restore();
    delete process.env.NEXUS_OPENAI_API_KEY;
  }
});

test("chat-mode: streaming via onDelta → accumulates text + reports usage", async () => {
  const gw = _load();
  process.env.NEXUS_DEEPSEEK_API_KEY = "sk-test";
  // Mock fetch returning an SSE stream.
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n',
    'data: [DONE]\n',
  ];
  const restore = _mockFetch(async () => {
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < sseChunks.length) {
          controller.enqueue(new TextEncoder().encode(sseChunks[i++]));
        } else {
          controller.close();
        }
      },
    });
    return { ok: true, status: 200, body: stream };
  });
  try {
    const deltas = [];
    const r = await gw.dispatchCall({
      skill: "nexus.chat",
      tier: "balanced",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (chunk) => deltas.push(chunk),
      maxOutputTokens: 100,
    });
    assert.equal(r.outcome, "allow");
    assert.equal(r.text, "Hello world");
    assert.equal(r.tokensIn, 4);
    assert.equal(r.tokensOut, 2);
    assert.deepEqual(deltas, ["Hello", " world"]);
  } finally {
    restore();
    delete process.env.NEXUS_DEEPSEEK_API_KEY;
  }
});

test("chat-mode: assistant message with tool_use blocks → translated to OpenAI tool_calls", async () => {
  const gw = _load();
  process.env.NEXUS_DEEPSEEK_API_KEY = "sk-test";
  let observedMessages = null;
  const restore = _mockFetch(async (_url, opts) => {
    observedMessages = JSON.parse(opts.body).messages;
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "done" } }], usage: {} }),
    };
  });
  try {
    await gw.dispatchCall({
      skill: "nexus.chat",
      tier: "balanced",
      messages: [
        { role: "user", content: "what's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Hanoi" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "Sunny, 28°C" },
          ],
        },
      ],
      tools: [{ name: "get_weather", description: "x", input_schema: {} }],
      maxOutputTokens: 100,
    });
    // user → user, assistant with tool_use → assistant with tool_calls, user tool_result → tool role.
    assert.equal(observedMessages.find((m) => m.role === "assistant").tool_calls.length, 1);
    assert.equal(observedMessages.find((m) => m.role === "assistant").tool_calls[0].id, "call_1");
    const toolMsg = observedMessages.find((m) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "call_1");
    assert.equal(toolMsg.content, "Sunny, 28°C");
  } finally {
    restore();
    delete process.env.NEXUS_DEEPSEEK_API_KEY;
  }
});
