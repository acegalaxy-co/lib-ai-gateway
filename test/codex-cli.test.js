"use strict";

// commons/ai-gateway/test/codex-cli.test.js
// Mocks child_process.spawn to avoid invoking the real `codex` CLI.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Writable } = require("node:stream");
const cpModule = require("child_process");
const origSpawn = cpModule.spawn;

function _makeStubCodex(stdoutChunks, stderrChunks, exitCode, signal, captureArgv, captureStdin, captureOpts) {
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
  const adapterPath = path.join(__dirname, "..", "dist", "adapters", "subscription", "codex-cli.js");
  delete require.cache[require.resolve(adapterPath)];
  return require(adapterPath).CodexCLIAdapter;
}

test("codex-cli: success path returns stdout text and estimated tokens", async () => {
  const captured = {};
  const stdinCapture = [];
  const optsCapture = {};
  const stub = _makeStubCodex(["Hello world"], [], 0, null, captured, stdinCapture, optsCapture);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    const r = await adapter.complete({
      prompt: "say hi",
      model: "o1",
      maxOutputTokens: 100,
    });

    assert.equal(r.text, "Hello world");
    assert.ok(r.tokensIn > 0);
    assert.ok(r.tokensOut > 0);
    assert.equal(r.schemaJson, null);
    assert.deepEqual(optsCapture.opts.stdio, ["pipe", "pipe", "pipe"]);
    assert.ok(captured.argv.includes("exec"));
    assert.equal(captured.argv[captured.argv.indexOf("-s") + 1], "read-only");
    assert.ok(captured.argv.includes("-m"));
    assert.equal(captured.argv[captured.argv.indexOf("-m") + 1], "o1");
    assert.equal(captured.argv.includes("say hi"), false);
    assert.equal(stdinCapture.join(""), "say hi");
  });
});

test("codex-cli: --mcp-config passed when provided and prompt stays off argv", async () => {
  const captured = {};
  const stdinCapture = [];
  const stub = _makeStubCodex(["done"], [], 0, null, captured, stdinCapture);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    await adapter.complete({
      prompt: "config test",
      model: "gpt-5-codex",
      maxOutputTokens: 100,
      mcpConfigPath: "/etc/codex/mcp.yml",
    });

    const idxConfig = captured.argv.indexOf("--mcp-config");
    assert.ok(idxConfig > -1);
    assert.equal(captured.argv[idxConfig + 1], "/etc/codex/mcp.yml");
    assert.ok(captured.argv.includes("exec"));
    assert.equal(captured.argv.includes("config test"), false);
    assert.equal(stdinCapture.join(""), "config test");
  });
});

test("codex-cli: null bytes are stripped from stdin and never appear in argv", async () => {
  const captured = {};
  const stdinCapture = [];
  const stub = _makeStubCodex(["ok"], [], 0, null, captured, stdinCapture);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    await adapter.complete({
      prompt: "hello\x00world",
      model: "",
      maxOutputTokens: 100,
    });

    const stdinText = stdinCapture.join("");
    assert.equal(stdinText, "helloworld");
    assert.equal(stdinText.includes("\x00"), false);
    assert.equal(captured.argv.includes("helloworld"), false);
    assert.equal(captured.argv.includes("hello\x00world"), false);
  });
});

test("codex-cli: non-zero exit rejects with stderr", async () => {
  const stub = _makeStubCodex(["partial"], ["error: bad input\n"], 1);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 }),
      /codex exit 1.*bad input/
    );
  });
});

test("codex-cli: timeout signal rejects with killed reason", async () => {
  const stub = _makeStubCodex([], [], null, "SIGKILL");

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100, timeoutMs: 50 }),
      /killed.*SIGKILL/
    );
  });
});

test("codex-cli: empty stdout rejects", async () => {
  const stub = _makeStubCodex([""], [], 0);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 }),
      /empty output/
    );
  });
});

test("codex-cli: schema plus JSON-fenced output populates schemaJson", async () => {
  const stub = _makeStubCodex(['```json\n{"vendor":"OpenAI"}\n```'], [], 0);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    const r = await adapter.complete({
      prompt: "extract",
      model: "m",
      maxOutputTokens: 100,
      schema: { type: "object" },
    });

    assert.deepEqual(r.schemaJson, { vendor: "OpenAI" });
  });
});

test("codex-cli: empty model omits -m", async () => {
  const captured = {};
  const stub = _makeStubCodex(["ok"], [], 0, null, captured);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    await adapter.complete({
      prompt: "x",
      model: "",
      maxOutputTokens: 100,
    });

    assert.equal(captured.argv.includes("-m"), false);
  });
});

test("codex-cli: whitespace-only model omits -m", async () => {
  const captured = {};
  const stub = _makeStubCodex(["ok"], [], 0, null, captured);

  await _withSpawn(stub, async () => {
    const CodexCLIAdapter = _loadAdapter();
    const adapter = new CodexCLIAdapter();
    await adapter.complete({
      prompt: "x",
      model: "   ",
      maxOutputTokens: 100,
    });

    assert.equal(captured.argv.includes("-m"), false);
  });
});
