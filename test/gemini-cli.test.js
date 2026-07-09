"use strict";

// commons/ai-gateway/test/gemini-cli.test.js
// Mocks child_process.spawn to avoid invoking the real `gemini` CLI.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Writable } = require("node:stream");
const cpModule = require("child_process");
const origSpawn = cpModule.spawn;

function _makeStub(stdoutChunks, stderrChunks, exitCode, signal, captureArgv, captureStdin, captureOpts) {
  return function _spawnStub(cmd, argv, opts) {
    if (captureArgv) {
      captureArgv.cmd = cmd;
      captureArgv.argv = argv;
    }
    if (captureOpts) captureOpts.opts = opts;

    const child = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        if (captureStdin) captureStdin.push(chunk.toString());
        cb();
      },
    });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    setImmediate(() => {
      for (const c of stdoutChunks) child.stdout.emit("data", typeof c === "string" ? Buffer.from(c) : c);
      for (const c of stderrChunks) child.stderr.emit("data", typeof c === "string" ? Buffer.from(c) : c);
      child.emit("close", exitCode, signal);
    });
    return child;
  };
}

function _withSpawn(stub, fn) {
  cpModule.spawn = stub;
  return Promise.resolve().then(fn).finally(() => { cpModule.spawn = origSpawn; });
}

function _loadAdapter() {
  const adapterPath = path.join(__dirname, "..", "dist", "adapters", "subscription", "gemini-cli.js");
  delete require.cache[require.resolve(adapterPath)];
  return require(adapterPath).GeminiCLIAdapter;
}

test("gemini-cli: success path returns stdout text and estimated tokens", async () => {
  const captured = {};
  const stdinCapture = [];
  const optsCapture = {};
  const stub = _makeStub(["abcd"], [], 0, null, captured, stdinCapture, optsCapture);

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    const r = await adapter.complete({
      prompt: "abc",
      model: "",
      maxOutputTokens: 100,
    });

    assert.equal(r.text, "abcd");
    assert.equal(r.tokensIn, 1);
    assert.equal(r.tokensOut, 2);
    assert.equal(r.schemaJson, null);
    assert.deepEqual(optsCapture.opts.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(captured.argv.includes("-p"), true);
    assert.equal(captured.argv[captured.argv.indexOf("-p") + 1], "-");
    assert.equal(captured.argv.includes("abc"), false);
    assert.equal(stdinCapture.join(""), "abc");
    assert.equal(captured.argv.includes("-m"), false);
  });
});

test("gemini-cli: non-empty model adds -m model", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await adapter.complete({
      prompt: "hello",
      model: "gemini-2.5-pro",
      maxOutputTokens: 100,
    });

    const idx = captured.argv.indexOf("-m");
    assert.ok(idx > -1);
    assert.equal(captured.argv[idx + 1], "gemini-2.5-pro");
  });
});

test("gemini-cli: empty and whitespace model omit -m", async () => {
  const capturedA = {};
  const capturedB = {};

  await _withSpawn(_makeStub(["a"], [], 0, null, capturedA), async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await adapter.complete({ prompt: "x", model: "", maxOutputTokens: 100 });
    assert.equal(capturedA.argv.includes("-m"), false);
  });

  await _withSpawn(_makeStub(["a"], [], 0, null, capturedB), async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await adapter.complete({ prompt: "x", model: "   ", maxOutputTokens: 100 });
    assert.equal(capturedB.argv.includes("-m"), false);
  });
});

test("gemini-cli: null bytes are stripped from stdin and never appear in argv", async () => {
  const captured = {};
  const stdinCapture = [];
  const stub = _makeStub(["any"], [], 0, null, captured, stdinCapture);

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await adapter.complete({
      prompt: "a\x00b",
      model: "",
      maxOutputTokens: 100,
    });

    const stdinText = stdinCapture.join("");
    assert.equal(stdinText, "ab");
    assert.equal(stdinText.includes("\x00"), false);
    assert.equal(captured.argv.some((arg) => typeof arg === "string" && arg.includes("\x00")), false);
    assert.equal(captured.argv.includes("ab"), false);
    assert.equal(captured.argv.includes("a\x00b"), false);
  });
});

test("gemini-cli: non-zero exit rejects with stderr", async () => {
  const stub = _makeStub(["ignored"], ["something went wrong"], 1, null);

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "", maxOutputTokens: 100 }),
      /gemini exit 1.*something went wrong/
    );
  });
});

test("gemini-cli: timeout signal rejects with killed reason", async () => {
  const stub = _makeStub(["unused"], [], null, "SIGKILL");

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "y", model: "", maxOutputTokens: 100, timeoutMs: 50 }),
      /killed.*SIGKILL/
    );
  });
});

test("gemini-cli: empty stdout rejects", async () => {
  const stub = _makeStub([], [], 0, null);

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "y", model: "", maxOutputTokens: 100 }),
      /empty output/
    );
  });
});

test("gemini-cli: schema plus JSON-fenced output populates schemaJson", async () => {
  const stub = _makeStub(['```json\n{"key":"value"}\n```'], [], 0, null);

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    const r = await adapter.complete({
      prompt: "generate",
      model: "",
      maxOutputTokens: 100,
      schema: { type: "object" },
    });

    assert.deepEqual(r.schemaJson, { key: "value" });
    assert.match(r.text, /```json/);
  });
});
