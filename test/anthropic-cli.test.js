"use strict";

// commons/ai-gateway/test/anthropic-cli.test.js
// Mocks child_process.spawn to avoid invoking the real `claude` CLI.
// Validates argv shape, stdout capture, exit-code error handling, JSON schema parse.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Intercept `require("child_process")` BEFORE the adapter is required.
// node:test runs each test() top-down in the same process; we replace
// require.cache for child_process so the adapter picks up our stub.
const cpModule = require("child_process");
const origSpawn = cpModule.spawn;

function _makeStub(stdoutChunks, stderrChunks, exitCode = 0, signal = null, captureArgv = null) {
  return function _spawnStub(cmd, argv, _opts) {
    if (captureArgv) {
      captureArgv.cmd = cmd;
      captureArgv.argv = argv;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Emit on next tick so the listener gets attached first.
    setImmediate(() => {
      for (const c of stdoutChunks) child.stdout.emit("data", Buffer.from(c));
      for (const c of stderrChunks) child.stderr.emit("data", Buffer.from(c));
      child.emit("close", exitCode, signal);
    });
    return child;
  };
}

function _withSpawn(stub, fn) {
  cpModule.spawn = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => { cpModule.spawn = origSpawn; });
}

// Adapter is required AFTER possibly replacing spawn, but it captures `spawn`
// at module top-level. Bust the cache so each test gets a fresh require.
function _loadAdapter() {
  const adapterPath = path.join(__dirname, "..", "dist", "adapters", "anthropic-cli.js");
  delete require.cache[require.resolve(adapterPath)];
  return require(adapterPath).AnthropicCLIAdapter;
}

test("anthropic-cli: success path → stdout becomes text, tokens estimated", async () => {
  const captured = {};
  const stub = _makeStub(["Hello", " world\n"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    const r = await adapter.complete({
      prompt: "say hi",
      model: "claude-sonnet-4-6",
      maxOutputTokens: 100,
    });
    assert.equal(r.text, "Hello world");
    assert.ok(r.tokensIn > 0);
    assert.ok(r.tokensOut > 0);
    assert.equal(r.schemaJson, null);
    // argv shape: [..., --permission-mode acceptEdits, -p <prompt>]
    assert.ok(captured.argv.includes("--permission-mode"));
    assert.ok(captured.argv.includes("acceptEdits"));
    assert.ok(captured.argv.includes("-p"));
    assert.equal(captured.argv[captured.argv.length - 1], "say hi");
  });
});

test("anthropic-cli: allowedTools binding → injected before -p", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "search news",
      model: "m", maxOutputTokens: 100,
      allowedTools: "WebSearch,Bash",
    });
    const idxTools = captured.argv.indexOf("--allowedTools");
    const idxP = captured.argv.indexOf("-p");
    assert.ok(idxTools > -1);
    assert.equal(captured.argv[idxTools + 1], "WebSearch,Bash");
    assert.ok(idxTools < idxP, "tools must precede -p so prompt isn't swallowed");
  });
});

test("anthropic-cli: non-zero exit → reject with stderr", async () => {
  const stub = _makeStub(["partial"], ["error: bad request\n"], 1);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 }),
      /claude exit 1.*bad request/
    );
  });
});

test("anthropic-cli: timeout signal → reject with kill reason", async () => {
  const stub = _makeStub([], [], null, "SIGKILL");
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100, timeoutMs: 50 }),
      /killed.*SIGKILL/
    );
  });
});

test("anthropic-cli: empty stdout → reject", async () => {
  const stub = _makeStub([""], [], 0);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 }),
      /empty output/
    );
  });
});

test("anthropic-cli: schema + JSON-fenced output → schemaJson parsed", async () => {
  const stub = _makeStub(['```json\n{"vendor":"Anthropic"}\n```'], [], 0);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    const r = await adapter.complete({
      prompt: "extract", model: "m", maxOutputTokens: 100,
      schema: { type: "object" },
    });
    assert.deepEqual(r.schemaJson, { vendor: "Anthropic" });
  });
});

test("anthropic-cli: null bytes in prompt are stripped before spawn", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "hello\x00world",
      model: "m", maxOutputTokens: 100,
    });
    const last = captured.argv[captured.argv.length - 1];
    assert.equal(last, "helloworld");
    assert.ok(!last.includes("\x00"));
  });
});

// ============================================================
// 2026-07-07: --model flag support (was previously ignored).
// Adapter must pass `--model <name>` to CLI when model is non-empty,
// so policy binding (or env override resolved by dispatchCall) actually
// takes effect. Empty model → skip flag, CLI falls back to subscription
// default (backward-compat with earlier callers passing model:"m" etc.).
// ============================================================
test("anthropic-cli: model non-empty → --model <name> in argv before -p", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "extract",
      model: "claude-haiku-4-5",
      maxOutputTokens: 100,
    });
    const idxModel = captured.argv.indexOf("--model");
    const idxP = captured.argv.indexOf("-p");
    assert.ok(idxModel > -1, "--model flag must be present when model non-empty");
    assert.equal(captured.argv[idxModel + 1], "claude-haiku-4-5");
    assert.ok(idxModel < idxP, "--model must precede -p so prompt isn't swallowed");
  });
});

test("anthropic-cli: empty model → --model flag omitted (CLI default)", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "extract",
      model: "",
      maxOutputTokens: 100,
    });
    assert.equal(captured.argv.indexOf("--model"), -1, "--model must be omitted for empty model");
  });
});

test("anthropic-cli: whitespace-only model → --model omitted (treated as empty)", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "extract",
      model: "   ",
      maxOutputTokens: 100,
    });
    assert.equal(captured.argv.indexOf("--model"), -1, "--model must be omitted for whitespace-only");
  });
});
