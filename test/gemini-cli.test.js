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

// ============================================================
// 2026-09-28: gateway now owns gemini CLI spawns for browse tasks (was
// previously spawned by the consumer directly). New options below; all
// optional, no-op when unset (see "argv identical to before" test).
// ============================================================

test("gemini-cli: yolo + outputJson + allowedMcpServerNames + coreTools build argv/env, parse envelope, cleanup temp file", async () => {
  const fs = require("node:fs");
  const captured = {};
  const optsCapture = {};
  let settingsFileContentAtSpawnTime = null;

  const stub = function _spawnStub(cmd, argv, opts) {
    captured.cmd = cmd;
    captured.argv = argv;
    optsCapture.opts = opts;
    // Read the coreTools settings file while it still exists (adapter
    // removes it in a `finally` after the child closes).
    const settingsPath = opts.env && opts.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    if (settingsPath) settingsFileContentAtSpawnTime = fs.readFileSync(settingsPath, "utf8");

    const child = new EventEmitter();
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify({ response: "hello from envelope" })));
      child.emit("close", 0, null);
    });
    return child;
  };

  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    const r = await adapter.complete({
      prompt: "browse",
      model: "",
      maxOutputTokens: 100,
      cwd: "/tmp/some-project",
      yolo: true,
      outputJson: true,
      allowedMcpServerNames: ["cloakbrowser", "fs"],
      coreTools: ["run_shell_command", "web_fetch"],
    });

    assert.equal(r.text, "hello from envelope");
    assert.ok(captured.argv.includes("--yolo"));
    const idxO = captured.argv.indexOf("-o");
    assert.ok(idxO > -1);
    assert.equal(captured.argv[idxO + 1], "json");

    const nameIdx = [];
    captured.argv.forEach((a, i) => { if (a === "--allowed-mcp-server-names") nameIdx.push(i); });
    assert.equal(nameIdx.length, 2, "one --allowed-mcp-server-names flag per entry");
    assert.equal(captured.argv[nameIdx[0] + 1], "cloakbrowser");
    assert.equal(captured.argv[nameIdx[1] + 1], "fs");

    assert.equal(optsCapture.opts.cwd, "/tmp/some-project");
    assert.equal(optsCapture.opts.detached, true);

    assert.ok(settingsFileContentAtSpawnTime, "settings file must exist while child is running");
    // gemini-cli >=0.4x reads tool restriction from nested tools.core — a
    // flat coreTools key is silently ignored (verified live).
    assert.deepEqual(JSON.parse(settingsFileContentAtSpawnTime), {
      tools: { core: ["run_shell_command", "web_fetch"] },
    });

    // Cleanup happens after close — temp dir must be gone by the time complete() resolves.
    const settingsPath = optsCapture.opts.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    assert.equal(fs.existsSync(settingsPath), false, "temp settings file removed after completion");
  });
});

test("gemini-cli: -o json non-JSON envelope rejects with explicit message", async () => {
  const stub = _makeStub(["not json at all"], [], 0, null);
  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "", maxOutputTokens: 100, outputJson: true }),
      /gemini -o json returned non-JSON envelope/
    );
  });
});

test("gemini-cli: -o json falls back result -> text when response missing", async () => {
  const stub = _makeStub([JSON.stringify({ result: "from result field" })], [], 0, null);
  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    const r = await adapter.complete({ prompt: "x", model: "", maxOutputTokens: 100, outputJson: true });
    assert.equal(r.text, "from result field");
  });
});

test("gemini-cli: with no new options, argv/opts identical to pre-change shape", async () => {
  const captured = {};
  const optsCapture = {};
  const stub = _makeStub(["ok"], [], 0, null, captured, [], optsCapture);
  await _withSpawn(stub, async () => {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await adapter.complete({ prompt: "x", model: "", maxOutputTokens: 100 });
    assert.deepEqual(captured.argv, ["-p", "-"]);
    assert.equal(optsCapture.opts.cwd, undefined);
    assert.equal(optsCapture.opts.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined);
    assert.deepEqual(optsCapture.opts.stdio, ["pipe", "pipe", "pipe"]);
  });
});

test("gemini-cli: timeout kills whole process group (grandchild survives spawn but dies with parent)", { skip: process.platform === "win32" }, async () => {
  const fs = require("node:fs");
  const os = require("node:os");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-pgkill-"));
  const scriptPath = path.join(tmpDir, "fake-gemini.sh");
  const pidFile = path.join(tmpDir, "grandchild.pid");
  fs.writeFileSync(scriptPath, "#!/bin/sh\nsleep 60 &\necho $! > \"$PIDFILE\"\nwait\n");
  fs.chmodSync(scriptPath, 0o755);

  const origBin = process.env.GEMINI_CLI_BIN;
  const origPidFile = process.env.PIDFILE;
  process.env.GEMINI_CLI_BIN = scriptPath;
  process.env.PIDFILE = pidFile;

  try {
    const GeminiCLIAdapter = _loadAdapter();
    const adapter = new GeminiCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "", maxOutputTokens: 100, timeoutMs: 300 }),
      /gemini killed \(SIGKILL\) — timeout\?/,
    );

    let grandchildPid = null;
    for (let i = 0; i < 20 && grandchildPid === null; i++) {
      if (fs.existsSync(pidFile)) {
        const raw = fs.readFileSync(pidFile, "utf8").trim();
        if (raw) grandchildPid = parseInt(raw, 10);
      }
      if (grandchildPid === null) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(grandchildPid, "expected grandchild pid to be recorded by fake CLI script");

    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch (_e) {
        alive = false;
      }
    }
    assert.equal(alive, false, "grandchild process must be killed along with the process group");
  } finally {
    if (origBin === undefined) delete process.env.GEMINI_CLI_BIN; else process.env.GEMINI_CLI_BIN = origBin;
    if (origPidFile === undefined) delete process.env.PIDFILE; else process.env.PIDFILE = origPidFile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
