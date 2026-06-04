"use strict";

// commons/ai-gateway/test/dispatch-embed.test.js
// End-to-end test for dispatchEmbed() pipeline (L1→L5 with embed adapter).

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
  const tmpLog = path.join(ROOT, "test", ".tmp-audit-embed.log");
  try { fs.unlinkSync(tmpLog); } catch (_e) { /* ignore */ }
  process.env.AI_GATEWAY_AUDIT_LOG_PATH = tmpLog;
  return { gw: require(path.join(DIST, "index.js")), tmpLog };
}

function _mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

test("dispatchEmbed: rag.embed fast → openai-embeddings allow path", async () => {
  const { gw } = _load();
  process.env.NEXUS_OPENAI_API_KEY = "sk-test";
  const restore = _mockFetch(async (url, opts) => {
    assert.equal(url, "https://api.openai.com/v1/embeddings");
    const body = JSON.parse(opts.body);
    assert.equal(body.model, "text-embedding-3-small");
    return {
      ok: true, status: 200,
      json: async () => ({
        data: body.input.map((_s, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })),
        usage: { prompt_tokens: 12 },
      }),
    };
  });
  try {
    const r = await gw.dispatchEmbed({
      skill: "rag.embed",
      tier: "fast",
      inputs: ["doc-1", "doc-2"],
    });
    assert.equal(r.outcome, "allow");
    assert.equal(r.provider, "openai-embeddings");
    assert.equal(r.model, "text-embedding-3-small");
    assert.equal(r.vectors.length, 2);
    assert.equal(r.tokensIn, 12);
  } finally {
    restore();
    delete process.env.NEXUS_OPENAI_API_KEY;
  }
});

test("dispatchEmbed: unknown skill on tier without embed-capable provider → L2 deny", async () => {
  const { gw } = _load();
  // '*' policy maps balanced → openai-compat (text completion). Embed should
  // reject because that adapter has no embed() method.
  const r = await gw.dispatchEmbed({
    skill: "rag.embed",
    tier: "deep",      // rag.embed has no 'deep' binding
    inputs: ["x"],
  });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L2_authz");
});

test("dispatchEmbed: provider missing embed() method → L1 deny", async () => {
  const { gw } = _load();
  // Manually craft a request that resolves to a text-only provider via '*' policy.
  const r = await gw.dispatchEmbed({
    skill: "unknown.embed",
    tier: "fast",      // '*' fast → openai-compat (text), no embed()
    inputs: ["x"],
  });
  assert.equal(r.outcome, "deny");
  assert.equal(r.denyReason, "L1_provider_unavailable");
});

test("dispatchEmbed: audit log records call with provider+model+tokensIn", async () => {
  const { gw, tmpLog } = _load();
  process.env.NEXUS_OPENAI_API_KEY = "sk-test";
  const restore = _mockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({
      data: [{ index: 0, embedding: [0.5] }],
      usage: { prompt_tokens: 3 },
    }),
  }));
  try {
    await gw.dispatchEmbed({ skill: "rag.embed", tier: "fast", inputs: ["x"] });
    await new Promise((r) => setTimeout(r, 20));
    const lines = fs.readFileSync(tmpLog, "utf8").trim().split("\n").filter(Boolean);
    const rec = JSON.parse(lines[lines.length - 1]);
    assert.equal(rec.skill, "rag.embed");
    assert.equal(rec.provider, "openai-embeddings");
    assert.equal(rec.model, "text-embedding-3-small");
    assert.equal(rec.tokensIn, 3);
    assert.equal(rec.outcome, "allow");
  } finally {
    restore();
    delete process.env.NEXUS_OPENAI_API_KEY;
  }
});
